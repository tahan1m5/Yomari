import Dexie, { type Table } from 'dexie'

export const statuses = ['Reading', 'Plan to read', 'Completed', 'On hold', 'Dropped'] as const
export type Status = typeof statuses[number]
export type Manga = {
  id: string; sourceId?: string; title: string; customTitle?: string; author: string; description: string
  status: string; chapter: number; latest?: number; tags: string[]; collections: string[]
  primary?: string; added: number; sample?: boolean; rating?: number; notes?: string
  source?: Provider; sourceKey?: string; chapterSourceId?: string; sourceUrl?: string
  genres?: string[]; favorite?: boolean; archived?: boolean; latestLanguage?: string
  rereads?: number; readAt?: number
}
export type Artwork = { id: string; mangaId: string; kind: 'cover' | 'gallery'; image: Blob | string; label: string; added?: number; caption?: string }
export type Collection = { id: string; name: string }
export type ReadingEvent = { id: string; mangaId: string; at: number; chapter: number; kind: 'progress' | 'reread' }
export const providers = { mangadex: 'MangaDex', kitsu: 'Kitsu', jikan: 'MyAnimeList (Jikan)' } as const
export type Provider = keyof typeof providers
export const pages = ['Library', 'Collections', 'Gallery', 'Badges', 'Settings'] as const
export type View = typeof pages[number]
export const defaultPreferences = {
  theme: 'light' as 'light' | 'dark' | 'system', layout: 'grid' as 'grid' | 'list' | 'compact',
  accent: '' as string, cardStyle: 'rounded' as 'rounded' | 'square', monochrome: true,
  showStats: true, showUpdates: true, showRecommendations: true,
  hiddenPages: [] as View[], startPage: 'Library' as View,
  customStatuses: [] as string[], compress: true, language: 'en' as string,
}
export type Preferences = typeof defaultPreferences
export type Options = { id: 'preferences'; preferences: Preferences; earned: string[] }

class Library extends Dexie {
  manga!: Table<Manga, string>
  artwork!: Table<Artwork, string>
  collections!: Table<Collection, string>
  history!: Table<ReadingEvent, string>
  options!: Table<Options, string>

  constructor() {
    super('Yomari')
    this.version(1).stores({ manga: 'id,&sourceId,status,added', artwork: 'id,mangaId,kind', collections: 'id' })
    this.version(2).stores({
      manga: 'id,&sourceKey,status,added', history: 'id,mangaId,at', options: 'id',
    }).upgrade(transaction => transaction.table<Manga, string>('manga').toCollection().modify(manga => {
      if (!manga.sourceId) return
      manga.source = 'mangadex'
      manga.sourceKey = `mangadex:${manga.sourceId}`
      manga.chapterSourceId = manga.sourceId
      manga.sourceUrl = `https://mangadex.org/title/${manga.sourceId}`
    }))
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
export const hasUpdate = (manga: Manga, language: string) => Boolean(manga.chapterSourceId && (manga.latestLanguage ?? 'en') === language && !manga.archived && !['Dropped', 'Completed'].includes(manga.status) && (manga.latest ?? 0) > manga.chapter)

export async function checkMangaChapters(manga: Manga, language: string) {
  if (!manga.chapterSourceId) return
  const latest = await latestChapter(manga.chapterSourceId, language)
  await db.transaction('rw', db.manga, db.options, async () => {
    const current = await db.manga.get(manga.id)
    const options = await db.options.get('preferences')
    if (current?.chapterSourceId !== manga.chapterSourceId || (options?.preferences.language ?? 'en') !== language) return
    await db.manga.update(manga.id, { latest, latestLanguage: language })
  })
  return latest
}

export async function addTitle(title: string, author: string, result?: SearchResult) {
  const image = result?.cover ? await downloadCover(result.cover) : undefined
  return db.transaction('rw', db.manga, db.artwork, async () => {
    const sourceKey = result ? `${result.source}:${result.id}` : undefined
    const existing = sourceKey && await db.manga.where('sourceKey').equals(sourceKey).first()
    if (existing) return existing.id
    const id = crypto.randomUUID()
    const primary = image ? crypto.randomUUID() : undefined
    const added = Date.now()
    await db.manga.add({
      id, sourceId: result?.id, source: result?.source, sourceKey, sourceUrl: result?.url,
      chapterSourceId: result?.source === 'mangadex' ? result.id : undefined,
      title: result?.title || title.trim(), author: result?.author ?? author.trim(), description: result?.description ?? '',
      status: 'Plan to read', chapter: 0, tags: result?.tags ?? [], genres: result?.genres, collections: [], primary, added,
    })
    if (image && primary) await db.artwork.add({ id: primary, mangaId: id, label: 'Cover', kind: 'cover', image, added })
    return id
  })
}

export async function saveManga(id: string, changes: Partial<Manga>, reread = false) {
  await db.transaction('rw', db.manga, db.history, db.collections, async () => {
    const manga = await db.manga.get(id)
    if (!manga) return
    const at = Date.now()
    if (reread) {
      await db.history.add({ id: crypto.randomUUID(), mangaId: id, at, chapter: manga.chapter, kind: 'reread' })
      await db.manga.update(id, { chapter: 0, status: 'Reading', rereads: (manga.rereads ?? 0) + 1, readAt: at })
      return
    }
    if (changes.chapter !== undefined && changes.chapter !== manga.chapter) {
      await db.history.add({ id: crypto.randomUUID(), mangaId: id, at, chapter: changes.chapter, kind: 'progress' })
      changes = { ...changes, readAt: at }
    }
    if (changes.collections) {
      const existing = await db.collections.bulkGet(changes.collections)
      changes = { ...changes, collections: existing.flatMap(collection => collection ? [collection.id] : []) }
    }
    await db.manga.update(id, changes)
  })
}

export async function deleteArtwork(item: Artwork) {
  await db.transaction('rw', db.manga, db.artwork, async () => {
    await db.artwork.delete(item.id)
    const current = await db.manga.get(item.mangaId)
    if (current?.primary !== item.id) return
    const fallback = await db.artwork.where('mangaId').equals(item.mangaId).filter(art => art.kind === 'cover').first()
    await db.manga.update(item.mangaId, { primary: fallback?.id })
  })
}

export async function removeManga(ids: string[]) {
  await db.transaction('rw', db.manga, db.artwork, db.history, async () => {
    await db.manga.bulkDelete(ids)
    await db.artwork.where('mangaId').anyOf(ids).delete()
    await db.history.where('mangaId').anyOf(ids).delete()
  })
}

type Localized = Record<string, string>
type Result = {
  id: string
  attributes: { title: Localized; description: Localized; tags: { attributes: { name: Localized; group: string } }[] }
  relationships: { type: string; attributes?: { name?: string; fileName?: string } }[]
}

export type SearchResult = { id: string; source: Provider; title: string; description: string; author: string; tags: string[]; genres?: string[]; cover?: string; url?: string }
const localized = (values: Localized) => values.en || Object.values(values)[0] || ''

async function catalog<T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`https://api.mangadex.org/${path}?${params}`, { signal: signal ?? AbortSignal.timeout(12000) })
  if (!response.ok) throw new Error('MangaDex is unavailable. Try again.')
  return response.json()
}

export async function searchMangaDex(title: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const query = new URLSearchParams({ title, limit: '12', 'order[relevance]': 'desc' })
  query.append('includes[]', 'cover_art')
  query.append('includes[]', 'author')
  const { data } = await catalog<{ data: Result[] }>('manga', query, signal)
  return data.map(({ id, attributes, relationships }) => {
    const cover = relationships.find(item => item.type === 'cover_art')?.attributes?.fileName
    return {
      id, source: 'mangadex', title: localized(attributes.title), description: localized(attributes.description),
      author: relationships.filter(item => item.type === 'author').map(item => item.attributes?.name).filter(Boolean).join(', '),
      tags: attributes.tags.map(tag => localized(tag.attributes.name)).filter(Boolean),
      genres: attributes.tags.filter(tag => tag.attributes.group === 'genre').map(tag => localized(tag.attributes.name)).filter(Boolean),
      cover: cover ? `https://uploads.mangadex.org/covers/${id}/${cover}.512.jpg` : undefined, url: `https://mangadex.org/title/${id}`,
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

export async function latestChapter(mangaId: string, language = 'en') {
  const query = new URLSearchParams({ manga: mangaId, 'translatedLanguage[]': language, 'order[chapter]': 'desc', limit: '10' })
  const { data } = await catalog<{ data: { attributes: { chapter: string | null } }[] }>('chapter', query)
  const numbers = data.flatMap(item => {
    const chapter = item.attributes.chapter
    return chapter && Number.isFinite(Number(chapter)) ? [Number(chapter)] : []
  })
  return numbers.length ? Math.max(...numbers) : undefined
}
