import Dexie, { type Table } from 'dexie'

export const statuses = ['Reading', 'Plan to read', 'Completed', 'On hold', 'Dropped'] as const
export type Status = typeof statuses[number]
export type Manga = {
  id: string; sourceId?: string; title: string; customTitle?: string; author: string; description: string
  status: Status; chapter: number; latest?: number; tags: string[]; collections: string[]
  primary?: string; added: number; sample?: boolean; rating?: number; notes?: string
}
export type Artwork = { id: string; mangaId: string; kind: 'cover' | 'gallery'; image: Blob | string; label: string }
export type Collection = { id: string; name: string }

class Library extends Dexie {
  manga!: Table<Manga, string>
  artwork!: Table<Artwork, string>
  collections!: Table<Collection, string>

  constructor() {
    super('Yomari')
    this.version(1).stores({ manga: 'id,&sourceId,status,added', artwork: 'id,mangaId,kind', collections: 'id' })
    this.on('populate', async () => {
      const examples: [string, string, string, Status, number, number, string[]][] = [
        ['berserk', 'Berserk', 'Kentaro Miura', 'Reading', 163, 380, ['Dark fantasy', 'Seinen']],
        ['vagabond', 'Vagabond', 'Takehiko Inoue', 'Reading', 86, 327, ['Historical', 'Seinen']],
        ['punpun', 'Goodnight Punpun', 'Inio Asano', 'Completed', 147, 147, ['Drama', 'Seinen']],
        ['vinland', 'Vinland Saga', 'Makoto Yukimura', 'Reading', 112, 220, ['Historical', 'Action']],
        ['monster', 'Monster', 'Naoki Urasawa', 'Plan to read', 0, 162, ['Thriller', 'Seinen']],
        ['pluto', 'Pluto', 'Naoki Urasawa', 'On hold', 18, 65, ['Mystery', 'Sci-fi']],
      ]
      await this.manga.bulkAdd(examples.map(([id, title, author, status, chapter, latest, tags], index) => ({
        id, title, author, status, chapter, latest, tags, description: '', collections: [], primary: `${id}-cover`,
        added: Date.now() - index, sample: true,
      })))
      await this.artwork.bulkAdd(examples.map(([id, title]) => ({
        id: `${id}-cover`, mangaId: id, kind: 'cover', image: `/covers/${id}.jpg`, label: title,
      })))
    })
  }
}

export const db = new Library()
export const titleOf = (manga: Manga) => manga.customTitle || manga.title

export async function removeManga(ids: string[]) {
  await db.transaction('rw', db.manga, db.artwork, async () => {
    await db.manga.bulkDelete(ids)
    await db.artwork.where('mangaId').anyOf(ids).delete()
  })
}

type Localized = Record<string, string>
type Result = {
  id: string
  attributes: { title: Localized; description: Localized; tags: { attributes: { name: Localized } }[] }
  relationships: { type: string; attributes?: { name?: string; fileName?: string } }[]
}

export type SearchResult = { id: string; title: string; description: string; author: string; tags: string[]; cover?: string }
const localized = (values: Localized) => values.en || Object.values(values)[0] || ''

async function catalog<T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`https://api.mangadex.org/${path}?${params}`, { signal: signal ?? AbortSignal.timeout(12000) })
  if (!response.ok) throw new Error('MangaDex is unavailable. Try again.')
  return response.json()
}

export async function searchManga(title: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const query = new URLSearchParams({ title, limit: '12', 'order[relevance]': 'desc' })
  query.append('includes[]', 'cover_art')
  query.append('includes[]', 'author')
  const { data } = await catalog<{ data: Result[] }>('manga', query, signal)
  return data.map(({ id, attributes, relationships }) => {
    const cover = relationships.find(item => item.type === 'cover_art')?.attributes?.fileName
    return {
      id, title: localized(attributes.title), description: localized(attributes.description),
      author: relationships.filter(item => item.type === 'author').map(item => item.attributes?.name).filter(Boolean).join(', '),
      tags: attributes.tags.map(tag => localized(tag.attributes.name)).filter(Boolean),
      cover: cover ? `https://uploads.mangadex.org/covers/${id}/${cover}.512.jpg` : undefined,
    }
  })
}

export async function fetchCovers(mangaId: string) {
  const query = new URLSearchParams({ 'manga[]': mangaId, limit: '50', 'order[volume]': 'asc' })
  const { data } = await catalog<{ data: { id: string; attributes: { fileName: string; volume?: string } }[] }>('cover', query)
  return data.map(({ id, attributes }) => ({
    id, url: `https://uploads.mangadex.org/covers/${mangaId}/${attributes.fileName}.512.jpg`,
    label: attributes.volume ? `Volume ${attributes.volume}` : 'Cover',
  }))
}

export async function downloadCover(url: string): Promise<Blob | string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (response.ok) return await response.blob()
  } catch { /* The source may serve images without allowing cross-origin reads. */ }
  return url
}

export async function latestChapter(mangaId: string) {
  const query = new URLSearchParams({ manga: mangaId, 'translatedLanguage[]': 'en', 'order[chapter]': 'desc', limit: '10' })
  const { data } = await catalog<{ data: { attributes: { chapter: string | null } }[] }>('chapter', query)
  const numbers = data.flatMap(item => {
    const chapter = item.attributes.chapter
    return chapter && Number.isFinite(Number(chapter)) ? [Number(chapter)] : []
  })
  return numbers.length ? Math.max(...numbers) : undefined
}
