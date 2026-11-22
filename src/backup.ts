import { z } from 'zod'
import { db, defaultPreferences, pages, providers, type Artwork, type Options } from './library'

const id = z.string().min(1)
const number = z.number().min(0)
const timestamp = z.number().int().min(0).max(8.64e15)
const strings = z.array(z.string())
const source = z.enum(Object.keys(providers) as (keyof typeof providers)[])
const page = z.enum(pages)
const preferences = z.object({
  theme: z.enum(['light', 'dark', 'system']), layout: z.enum(['grid', 'list', 'compact']),
  accent: z.string().regex(/^(|#[a-f0-9]{6})$/i), cardStyle: z.enum(['rounded', 'square']), monochrome: z.boolean(),
  showStats: z.boolean(), showUpdates: z.boolean(), showRecommendations: z.boolean(), hiddenPages: z.array(page), startPage: page,
  customStatuses: strings, compress: z.boolean(), language: z.string().regex(/^[a-z]{2}(?:-[a-z]{2})?$/),
})
const manga = z.object({
  id, sourceId: id.optional(), source: source.optional(), sourceKey: id.optional(), chapterSourceId: id.optional(),
  sourceUrl: z.string().url().startsWith('https://').optional(),
  title: id, customTitle: z.string().optional(), author: z.string(), description: z.string(), status: id,
  chapter: number, latest: number.optional(), tags: strings, collections: strings, primary: id.optional(), added: timestamp,
  sample: z.boolean().optional(), rating: z.number().min(1).max(10).optional(), notes: z.string().optional(),
  genres: strings.optional(), favorite: z.boolean().optional(), archived: z.boolean().optional(), rereads: number.optional(), readAt: timestamp.optional(), latestLanguage: z.string().optional(),
})
const artwork = z.object({
  id, mangaId: id, kind: z.enum(['cover', 'gallery']), label: z.string(), added: timestamp.optional(), caption: z.string().optional(),
  image: z.string().regex(/^(?:https:\/\/\S+|\/covers\/[a-z]+\.jpg|data:image\/[\w.+-]+;base64,[a-z0-9+/]*={0,2})$/i),
})
const backupSchema = z.object({
  format: z.literal('yomari'), version: z.literal(1), manga: z.array(manga), artwork: z.array(artwork),
  collections: z.array(z.object({ id, name: id })), history: z.array(z.object({ id, mangaId: id, at: timestamp, chapter: number, kind: z.enum(['progress', 'reread']) })),
  options: z.object({ id: z.literal('preferences'), preferences, earned: strings }),
})

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function exportBackup() {
  const snapshot = await db.transaction('r', db.manga, db.artwork, db.collections, db.history, db.options, async () => ({
    manga: await db.manga.toArray(), artwork: await db.artwork.toArray(), collections: await db.collections.toArray(),
    history: await db.history.toArray(), options: await db.options.get('preferences') ?? { id: 'preferences', preferences: defaultPreferences, earned: [] },
  }))
  const images = await Promise.all(snapshot.artwork.map(async item => ({
    ...item, image: typeof item.image === 'string' ? item.image : await dataUrl(item.image),
  })))
  const blob = new Blob([JSON.stringify({ ...snapshot, artwork: images, format: 'yomari', version: 1 })], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `yomari-${new Date().toISOString().slice(0, 10)}.json`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function readBackup(file: File) {
  const text = await file.text()
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new Error('Invalid Yomari backup.') }
  const parsed = backupSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid Yomari backup.')
  const data = parsed.data
  const mangaById = new Map(data.manga.map(item => [item.id, item]))
  const artworkById = new Map(data.artwork.map(item => [item.id, item]))
  const collectionIds = new Set(data.collections.map(item => item.id))
  const duplicate = [data.manga, data.artwork, data.history, data.collections].some(items => new Set(items.map(item => item.id)).size !== items.length)
  const sourceKeys = data.manga.flatMap(item => item.sourceKey ? [item.sourceKey] : [])
  const invalid = data.manga.some(item => {
    const cover = item.primary ? artworkById.get(item.primary) : undefined
    return (item.primary && (cover?.mangaId !== item.id || cover.kind !== 'cover')) || item.collections.some(collection => !collectionIds.has(collection))
  }) || [...data.artwork, ...data.history].some(item => !mangaById.has(item.mangaId))
  if (duplicate || invalid || new Set(sourceKeys).size !== sourceKeys.length) throw new Error('Invalid library records in backup.')
  const images: Artwork[] = await Promise.all(data.artwork.map(async item => ({
    ...item, image: item.image.startsWith('data:') ? await (await fetch(item.image)).blob() : item.image,
  })))
  return { ...data, artwork: images }
}

export async function restoreBackup(data: Awaited<ReturnType<typeof readBackup>>) {
  await db.transaction('rw', db.manga, db.artwork, db.collections, db.history, db.options, async () => {
    await Promise.all([db.manga.clear(), db.artwork.clear(), db.collections.clear(), db.history.clear()])
    await db.manga.bulkAdd(data.manga)
    await db.collections.bulkAdd(data.collections)
    await db.artwork.bulkAdd(data.artwork)
    await db.history.bulkAdd(data.history)
    await db.options.put(data.options)
  })
}

export async function updateOptions(update: (current: Options) => Options) {
  await db.transaction('rw', db.options, async () => {
    const current = await db.options.get('preferences') ?? { id: 'preferences', preferences: defaultPreferences, earned: [] }
    await db.options.put(update(current))
  })
}
