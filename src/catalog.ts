import { providers, searchMangaDex, type Provider, type SearchResult } from './library'

type KitsuResource = {
  id: string; type: string
  attributes: { canonicalTitle?: string; synopsis?: string; title?: string; name?: string; role?: string; slug?: string; posterImage?: { large?: string } }
  relationships?: Record<string, { data?: { id: string; type: string } | { id: string; type: string }[] }>
}
type JikanTitle = {
  mal_id: number; title: string; title_english?: string; synopsis?: string; url: string
  authors: { name: string }[]; genres: { name: string }[]; themes: { name: string }[]
  images?: { jpg?: { large_image_url?: string } }
}

async function request<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`Catalog returned ${response.status}.`)
  return response.json()
}

async function kitsuTitles(filters: Record<string, string>): Promise<SearchResult[]> {
  const params = new URLSearchParams({ ...filters, 'page[limit]': '10', include: 'mangaStaff.person,categories' })
  const { data, included = [] } = await request<{ data: KitsuResource[]; included?: KitsuResource[] }>(`https://kitsu.io/api/edge/manga?${params}`)
  const resources = new Map(included.map(item => [`${item.type}:${item.id}`, item]))
  function related(item: KitsuResource, relationship: string) {
    const references = item.relationships?.[relationship]?.data
    return (Array.isArray(references) ? references : references ? [references] : []).flatMap(reference => {
      const resource = resources.get(`${reference.type}:${reference.id}`)
      return resource ? [resource] : []
    })
  }
  return data.flatMap(item => {
    const { canonicalTitle, synopsis, posterImage } = item.attributes
    if (!canonicalTitle) return []
    const genres = related(item, 'categories').flatMap(category => category.attributes.title || [])
    const authors = related(item, 'mangaStaff').filter(staff => !staff.attributes.role || /story|author/i.test(staff.attributes.role))
      .flatMap(staff => related(staff, 'person')).flatMap(person => person.attributes.name || [])
    return [{ id: item.id, source: 'kitsu', title: canonicalTitle, description: synopsis ?? '', author: [...new Set(authors)].join(', '), tags: [], genres, cover: posterImage?.large, url: `https://kitsu.io/manga/${item.attributes.slug ?? item.id}` }]
  })
}

async function searchJikan(title: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: title, limit: '10', sfw: 'true' })
  const { data } = await request<{ data: JikanTitle[] }>(`https://api.jikan.moe/v4/manga?${params}`)
  return data.map(item => ({
    id: String(item.mal_id), source: 'jikan', title: item.title_english || item.title,
    description: item.synopsis ?? '', author: item.authors.map(author => author.name).join(', '),
    tags: item.themes.map(theme => theme.name), genres: item.genres.map(genre => genre.name),
    cover: item.images?.jpg?.large_image_url, url: item.url,
  }))
}

const catalogs = { mangadex: searchMangaDex, kitsu: (title: string) => kitsuTitles({ 'filter[text]': title }), jikan: searchJikan }

export function discoverManga(genre: string) {
  const category = genre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return kitsuTitles({ 'filter[categories]': category, sort: '-userCount' })
}

export async function searchCatalog(title: string, source: Provider | 'all') {
  const selected = source === 'all' ? Object.keys(catalogs) as Provider[] : [source]
  const settled = await Promise.allSettled(selected.map(provider => catalogs[provider](title)))
  const unavailable: string[] = []
  const batches = settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value
    unavailable.push(providers[selected[index]])
    return []
  })
  const results = Array.from({ length: Math.max(0, ...batches.map(batch => batch.length)) }, (_, index) => (
    batches.flatMap(batch => batch[index] ? [batch[index]] : [])
  )).flat()
  return { results, unavailable }
}
