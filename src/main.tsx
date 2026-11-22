import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { useLiveQuery } from 'dexie-react-hooks'
import { BookOpen, LibraryBig, Layers, Images, Settings, Plus, Search, Grid2X2, List, X, ImagePlus, RotateCw, Trophy, HardDrive, Star } from 'lucide-react'
import { addTitle, checkMangaChapters, db, defaultPreferences, deleteArtwork, downloadCover, fetchCovers, hasUpdate, providers, removeManga, saveManga, searchMangaDex, statuses, titleOf, type Artwork, type Collection, type Manga, type Preferences, type Provider, type SearchResult, type View } from './library'
import { updateOptions } from './backup'
import { discoverManga, searchCatalog } from './catalog'
import { compressImage } from './images'
import { SettingsPanel } from './settings'
import './style.css'

const navigation = [[LibraryBig, 'Library'], [Layers, 'Collections'], [Images, 'Gallery'], [Trophy, 'Badges'], [Settings, 'Settings']] as const
const splitValues = (value: FormDataEntryValue | null) => [...new Set(String(value ?? '').split(',').map(word => word.trim()).filter(Boolean))]

function similarity(a: Manga, b: Manga) {
  const traits = new Set([...a.tags, ...(a.genres ?? [])].map(value => value.toLowerCase()))
  const shared = new Set([...b.tags, ...(b.genres ?? [])].map(value => value.toLowerCase()).filter(value => traits.has(value)))
  const authors = new Set(a.author.toLowerCase().split(',').map(name => name.trim()).filter(Boolean))
  return shared.size * 2 + (b.author.toLowerCase().split(',').some(name => authors.has(name.trim())) ? 4 : 0)
}

function sortArtwork(artwork: Artwork[], order: string) {
  return [...artwork].sort((a, b) => order === 'caption'
    ? (a.caption || a.label).localeCompare(b.caption || b.label)
    : order === 'oldest' ? (a.added ?? 0) - (b.added ?? 0) : (b.added ?? 0) - (a.added ?? 0))
}

function ArtworkSort({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <select aria-label="Sort images" value={value} onChange={event => onChange(event.target.value)}><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="caption">Caption</option></select>
}

function Art({ image, alt = '' }: { image?: string | Blob; alt?: string }) {
  const [objectUrl, setObjectUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
    if (!(image instanceof Blob)) return
    const url = URL.createObjectURL(image)
    setObjectUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [image])
  const src = typeof image === 'string' ? image : objectUrl
  return src && !failed ? <img src={src} alt={alt} onError={() => setFailed(true)} /> : <span className="art-fallback"><BookOpen size={34} strokeWidth={1.25} /></span>
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === dialog.current) onClose() }} aria-label={title}>
    <div className="dialog-inner"><div className="dialog-heading"><h2>{title}</h2><button className="icon" aria-label="Close" onClick={onClose}><X size={20} /></button></div>{children}</div>
  </dialog>
}

function ImageDetail({ item, close }: { item: Artwork; close: () => void }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function change(action: () => Promise<unknown>) {
    setBusy(true)
    setMessage('')
    try { await action() }
    catch { setMessage('Could not update image.') }
    finally { setBusy(false) }
  }
  return <Modal title={item.caption || item.label} onClose={close}>
    <div className="lightbox"><Art image={item.image} alt={item.caption || item.label} /></div>
    <form className="form" onSubmit={event => {
      event.preventDefault()
      const caption = String(new FormData(event.currentTarget).get('caption')).trim()
      void change(async () => { await db.artwork.update(item.id, { caption: caption || undefined }); setMessage('Caption saved.') })
    }}><label>Caption<input name="caption" defaultValue={item.caption} maxLength={240} /></label><div className="actions">
      <button className="solid" disabled={busy}>Save caption</button>
      <button type="button" disabled={busy} onClick={() => { if (confirm('Remove this image?')) void change(async () => { await deleteArtwork(item); close() }) }}>Remove image</button>
    </div></form>
    {message && <p className="muted" role="status">{message}</p>}
  </Modal>
}

function CollectionEditor({ collection, close, open }: { collection?: Collection; close: () => void; open: (id?: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function change(action: () => Promise<string | undefined>) {
    setBusy(true)
    setMessage('')
    try { open(await action()); close() }
    catch { setMessage('Could not update collection.') }
    finally { setBusy(false) }
  }
  return <Modal title={collection ? 'Edit collection' : 'New collection'} onClose={close}>
    <form className="form" onSubmit={event => {
      event.preventDefault()
      const name = String(new FormData(event.currentTarget).get('name')).trim()
      if (!name) { setMessage('Enter a collection name.'); return }
      void change(async () => {
        const id = collection?.id ?? crypto.randomUUID()
        if (collection) await db.collections.update(id, { name })
        else await db.collections.add({ id, name })
        return id
      })
    }}><label>Name<input name="name" autoFocus required maxLength={80} defaultValue={collection?.name} /></label><div className="actions">
      <button className="solid" disabled={busy}>{collection ? 'Save collection' : 'Create collection'}</button>
      {collection && <button type="button" disabled={busy} onClick={() => {
        if (!confirm(`Delete the collection “${collection.name}”? Its manga will stay in the library.`)) return
        void change(async () => {
          await db.transaction('rw', db.manga, db.collections, async () => {
            await db.collections.delete(collection.id)
            await db.manga.filter(item => item.collections.includes(collection.id)).modify(item => {
              item.collections = item.collections.filter(id => id !== collection.id)
            })
          })
          return undefined
        })
      }}>Delete collection</button>}
    </div></form>
    {message && <p role="status">{message}</p>}
  </Modal>
}

function AddManga({ close, open }: { close: () => void; open: (id: string) => void }) {
  const [mode, setMode] = useState<'search' | 'manual'>('search')
  const [source, setSource] = useState<Provider | 'all'>('all')
  const [query, setQuery] = useState('')
  const [author, setAuthor] = useState('')
  const [results, setResults] = useState<SearchResult[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function add(result?: SearchResult) {
    setBusy(true)
    setError('')
    try {
      const mangaId = await addTitle(query, author, result)
      close()
      open(mangaId)
    } catch { setError('Could not save manga.') }
    finally { setBusy(false) }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!query.trim()) return
    if (mode === 'manual') return add()
    setBusy(true)
    setError('')
    setResults(undefined)
    try {
      const found = await searchCatalog(query.trim(), source)
      setResults(found.results)
      if (found.unavailable.length) setError(`Unavailable: ${found.unavailable.join(', ')}.`)
    } catch { setError('Search failed. Try again.') }
    finally { setBusy(false) }
  }

  return <Modal title="Add manga" onClose={close}>
    <div className="tabs"><button aria-pressed={mode === 'search'} disabled={busy} onClick={() => { setMode('search'); setError('') }}>Catalog</button><button aria-pressed={mode === 'manual'} disabled={busy} onClick={() => { setMode('manual'); setError('') }}>Manual</button></div>
    <form onSubmit={submit} className="form">
      <label>{mode === 'search' ? 'Search title' : 'Title'}<input autoFocus required value={query} onChange={event => setQuery(event.target.value)} /></label>
      {mode === 'search' && <label>Source<select value={source} disabled={busy} onChange={event => { setSource(event.target.value as Provider | 'all'); setResults(undefined); setError('') }}><option value="all">All catalogs</option>{Object.entries(providers).map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select></label>}
      {mode === 'manual' && <label>Author<input value={author} onChange={event => setAuthor(event.target.value)} /></label>}
      <button className="solid" disabled={busy}>{busy ? 'Working…' : mode === 'search' ? 'Search' : 'Add manga'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {mode === 'search' && results && <div className="results">{results.length === 0 && !error && <p>No results</p>}{results.map(result => <button key={`${result.source}:${result.id}`} disabled={busy} onClick={() => void add(result)}><span className="result-art"><Art image={result.cover} /></span><span><strong>{result.title}</strong><small>{[result.author, providers[result.source]].filter(Boolean).join(' · ')}</small></span><Plus size={16} /></button>)}</div>}
  </Modal>
}

function MangaDetail({ manga, close, open, openImage, prefs }: {
  manga: Manga; close: () => void; open: (id: string) => void; openImage: (id: string) => void; prefs: Preferences
}) {
  const artwork = useLiveQuery(() => db.artwork.where('mangaId').equals(manga.id).toArray(), [manga.id], [])
  const collections = useLiveQuery(() => db.collections.toArray(), [], [])
  const history = useLiveQuery(async () => (await db.history.where('mangaId').equals(manga.id).sortBy('at')).reverse(), [manga.id], [])
  const related = useLiveQuery(async () => (await db.manga.toArray()).filter(item => item.id !== manga.id && !item.archived)
    .map(item => ({ item, score: similarity(manga, item) })).filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score).slice(0, 4).map(match => match.item), [manga], [])
  const [covers, setCovers] = useState<Awaited<ReturnType<typeof fetchCovers>>>()
  const [links, setLinks] = useState<SearchResult[]>()
  const [artOrder, setArtOrder] = useState('newest')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')

  async function perform(action: () => Promise<unknown>) {
    setBusy(true)
    setFeedback('')
    try { await action() }
    catch (error) { setFeedback(error instanceof Error ? error.message : 'Could not save changes.') }
    finally { setBusy(false) }
  }

  async function addArtwork(images: { image: Blob | string; label: string; id?: string }[], kind: Artwork['kind']) {
    await db.transaction('rw', db.manga, db.artwork, async () => {
      const current = await db.manga.get(manga.id)
      if (!current) return
      const records = images.map(({ image, label, id }) => ({ id: id ?? crypto.randomUUID(), image, label, mangaId: manga.id, kind, added: Date.now() }))
      await db.artwork.bulkPut(records)
      if (kind === 'cover' && !current.primary && records[0]) await db.manga.update(manga.id, { primary: records[0].id })
    })
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const title = String(data.get('title')).trim()
    if (!title) { setFeedback('Enter a title.'); return }
    void perform(async () => {
      await saveManga(manga.id, {
        customTitle: title === manga.title ? undefined : title, status: String(data.get('status')),
        author: String(data.get('author')).trim(), description: String(data.get('description')).trim(),
        chapter: Number(data.get('chapter')), tags: splitValues(data.get('tags')), genres: splitValues(data.get('genres')),
        notes: String(data.get('notes')), rating: Number(data.get('rating')) || undefined,
        collections: data.getAll('collections').map(String),
      })
      setFeedback('Saved.')
    })
  }

  return <Modal title={titleOf(manga)} onClose={close}>
    <div className="actions">
      <button aria-pressed={Boolean(manga.favorite)} disabled={busy} onClick={() => void perform(() => saveManga(manga.id, { favorite: !manga.favorite }))}><Star size={15} fill={manga.favorite ? 'currentColor' : 'none'} /> Favorite</button>
      <button disabled={busy} onClick={() => void perform(() => saveManga(manga.id, { archived: !manga.archived }))}>{manga.archived ? 'Unarchive' : 'Archive'}</button>
      {manga.source && manga.sourceUrl && <a className="source-link" href={manga.sourceUrl} target="_blank" rel="noreferrer">{providers[manga.source]}</a>}
      {manga.customTitle && <span className="muted">{manga.title}</span>}
    </div>
    <form className="form" onSubmit={save}>
      <label>Display title<input name="title" required defaultValue={titleOf(manga)} /></label>
      <label>Author<input name="author" defaultValue={manga.author} /></label>
      <div className="fields" key={manga.rereads ?? 0}><label>Status<select name="status" defaultValue={manga.status}>{[...new Set([...statuses, ...prefs.customStatuses, manga.status])].map(status => <option key={status}>{status}</option>)}</select></label><label>Last chapter<input name="chapter" type="number" min="0" step="any" required defaultValue={manga.chapter} /></label><label>Rating / 10<input name="rating" type="number" min="1" max="10" defaultValue={manga.rating} /></label></div>
      <label>Tags<input name="tags" defaultValue={manga.tags.join(', ')} placeholder="Separate with commas" /></label>
      <label>Genres<input name="genres" defaultValue={manga.genres?.join(', ')} placeholder="Separate with commas" /></label>
      <label>Synopsis<textarea name="description" defaultValue={manga.description} /></label>
      <label>Notes<textarea name="notes" defaultValue={manga.notes} /></label>
      {collections.length > 0 && <fieldset><legend>Collections</legend>{collections.map(collection => <label className="check" key={collection.id}><input type="checkbox" name="collections" value={collection.id} defaultChecked={manga.collections.includes(collection.id)} />{collection.name}</label>)}</fieldset>}
      <div className="actions"><button className="solid" disabled={busy}>Save changes</button>{manga.chapterSourceId && <button type="button" disabled={busy} onClick={() => void perform(async () => {
        const latest = await checkMangaChapters(manga, prefs.language)
        setFeedback(latest === undefined ? 'No chapters found.' : `Latest chapter: ${latest}`)
      })}><RotateCw size={15} /> Check chapters</button>}</div>
      {feedback && <p role="status" className="muted">{feedback}</p>}
    </form>
    <section className="detail-section">
      <div className="section-heading"><h3>Reading history</h3><button disabled={busy || !manga.chapter} onClick={() => {
        if (confirm('Start a reread from chapter zero?')) void perform(() => saveManga(manga.id, {}, true))
      }}>Start reread</button></div>
      {Boolean(manga.rereads) && <p className="muted">Rereads started: {manga.rereads}</p>}
      {history.length > 0 ? <details><summary>{history.length} {history.length === 1 ? 'entry' : 'entries'}</summary><ol className="reading-history">{history.map(entry => <li key={entry.id}><span>{entry.kind === 'reread' ? `Reread started after chapter ${entry.chapter}` : `Chapter ${entry.chapter}`}</span><time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString()}</time></li>)}</ol></details> : <p className="muted">No reading history yet</p>}
      {manga.source !== 'mangadex' && <div className="actions link-source">
        <button disabled={busy} onClick={() => void perform(async () => { setLinks(await searchMangaDex(titleOf(manga))) })}>{manga.chapterSourceId ? 'Change MangaDex link' : 'Link MangaDex for chapters'}</button>
        {manga.chapterSourceId && <button disabled={busy} onClick={() => void perform(() => db.manga.update(manga.id, { chapterSourceId: undefined, latest: undefined }))}>Unlink</button>}
      </div>}
      {links && <div className="results">{!links.length && <p>No MangaDex matches.</p>}{links.map(result => <button key={result.id} disabled={busy || result.id === manga.chapterSourceId} onClick={() => void perform(async () => {
        await db.manga.update(manga.id, { chapterSourceId: result.id, latest: undefined })
        setLinks(undefined)
        setCovers(undefined)
        setFeedback('MangaDex linked.')
      })}><span className="result-art"><Art image={result.cover} /></span><span><strong>{result.title}</strong><small>{result.author}</small></span><Plus size={16} /></button>)}</div>}
    </section>
    {(['cover', 'gallery'] as const).map(kind => <section className="detail-section" key={kind}>
      <div className="section-heading"><h3>{kind === 'cover' ? 'Covers' : 'Gallery'}</h3><div className="actions">
        <label className="button"><ImagePlus size={16} /> Upload<input className="visually-hidden" type="file" accept="image/*" multiple disabled={busy} onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []).filter(file => file.type.startsWith('image/'))
          event.currentTarget.value = ''
          void perform(async () => {
            const images = []
            for (const file of files) images.push({ image: prefs.compress ? await compressImage(file) : file, label: file.name })
            await addArtwork(images, kind)
          })
        }} /></label>
        {kind === 'cover' && manga.chapterSourceId && <button disabled={busy} onClick={() => void perform(async () => { setCovers(await fetchCovers(manga.chapterSourceId!)) })}>MangaDex</button>}
        {kind === 'gallery' && artwork.some(item => item.kind === 'gallery') && <ArtworkSort value={artOrder} onChange={setArtOrder} />}
      </div></div>
      <div className="art-grid">{sortArtwork(artwork.filter(item => item.kind === kind), artOrder).map(item => <div key={item.id}><button className="image-button" aria-label={`View ${item.caption || item.label}`} onClick={() => openImage(item.id)}><span className="mini-cover"><Art image={item.image} /></span></button>{item.caption && <p className="caption">{item.caption}</p>}<div className="art-actions">{kind === 'cover' && <button disabled={busy || manga.primary === item.id} onClick={() => void perform(() => db.manga.update(manga.id, { primary: item.id }))}>{manga.primary === item.id ? 'Primary' : 'Set primary'}</button>}<button disabled={busy} aria-label={`Remove ${item.label}`} onClick={() => { if (confirm('Remove this image?')) void perform(() => deleteArtwork(item)) }}><X size={14} /></button></div></div>)}</div>
      {kind === 'cover' && covers && <div className="art-grid">{covers.length === 0 && <p>No covers found.</p>}{covers.map(cover => {
        const id = `${manga.id}-${cover.id}`
        return <button key={cover.id} className="cover-choice" disabled={busy || artwork.some(item => item.id === id)} onClick={() => void perform(async () => {
          await addArtwork([{ id, image: await downloadCover(cover.url), label: cover.label }], 'cover')
        })}><span className="mini-cover"><Art image={cover.url} /></span>{cover.label}</button>
      })}</div>}
    </section>)}
    {related.length > 0 && <section className="detail-section"><h3>Similar in your library</h3><div className="actions">{related.map(item => <button key={item.id} onClick={() => open(item.id)}>{titleOf(item)}</button>)}</div></section>}
    <section className="detail-section"><button disabled={busy} onClick={() => { if (confirm(`Remove ${titleOf(manga)} and its images?`)) void perform(async () => { await removeManga([manga.id]); close() }) }}>Remove manga</button></section>
  </Modal>
}

function App() {
  const manga = useLiveQuery(() => db.manga.orderBy('added').reverse().toArray(), [], [])
  const artwork = useLiveQuery(() => db.artwork.toArray(), [], [])
  const collections = useLiveQuery(() => db.collections.toArray(), [], [])
  const options = useLiveQuery(() => db.options.get('preferences').then(value => value ?? null), [])
  const prefs = options?.preferences ?? defaultPreferences
  const [view, setView] = useState<View>('Library')
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [filter, setFilter] = useState('All')
  const [scope, setScope] = useState('active')
  const [tag, setTag] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('recent')
  const { layout } = prefs
  const [collectionId, setCollectionId] = useState<string>()
  const [collectionEditor, setCollectionEditor] = useState<'new' | 'edit'>()
  const [imageId, setImageId] = useState<string>()
  const [galleryFilter, setGalleryFilter] = useState('all')
  const [galleryTitle, setGalleryTitle] = useState('')
  const [galleryOrder, setGalleryOrder] = useState('newest')
  const [suggestions, setSuggestions] = useState<SearchResult[]>()
  const [discovering, setDiscovering] = useState(false)
  const [message, setMessage] = useState('')
  const [checking, setChecking] = useState(false)
  const opened = useRef(false)
  const checkRun = useRef(0)
  const checkKey = useRef('')
  const coverById = new Map(artwork.map(item => [item.id, item]))
  const lightbox = imageId ? coverById.get(imageId) : undefined
  const mangaById = new Map(manga.map(item => [item.id, item]))
  const detail = selected ? mangaById.get(selected) : undefined
  const activeCollection = collections.find(collection => collection.id === collectionId)
  const active = manga.filter(item => !item.archived)
  const updates = active.filter(item => hasUpdate(item, prefs.language))
  const tracked = active.filter(item => item.chapterSourceId && !['Dropped', 'Completed'].includes(item.status))
  const signature = tracked.map(item => `${item.id}:${item.chapterSourceId}`).sort().join(',')
  const tags = [...new Set(manga.flatMap(item => item.tags))].sort((a, b) => a.localeCompare(b))
  const includedStatuses = [...new Set([...statuses, ...prefs.customStatuses, ...manga.map(item => item.status)])]
  const reading = active.filter(item => !item.sample && (item.chapter > 0 || item.favorite || item.rating)).sort((a, b) => (b.readAt ?? b.added) - (a.readAt ?? a.added)).slice(0, 12)
  const recommendations = active.filter(item => !item.chapter && !item.sample && !item.favorite && item.status === 'Plan to read')
    .map(item => ({ item, score: reading.reduce((score, read, index) => score + similarity(read, item) * (1 + (read.rating ?? 0) / 10 + Number(Boolean(read.favorite))) / (index + 1), 0) }))
    .filter(match => match.score > 0).sort((a, b) => b.score - a.score).slice(0, 4).map(match => match.item)
  const categoryWeights = new Map<string, number>()
  reading.forEach((item, index) => {
    for (const genre of new Set([...(item.genres ?? []), ...item.tags])) {
      categoryWeights.set(genre, (categoryWeights.get(genre) ?? 0) + (1 + Number(Boolean(item.favorite))) / (index + 1))
    }
  })
  const discoveryCategories = [...categoryWeights].sort((a, b) => b[1] - a[1]).map(([name]) => name)
  const gallery = sortArtwork(artwork.filter(item => (galleryFilter === 'all' || item.kind === galleryFilter) && (!galleryTitle || item.mangaId === galleryTitle)), galleryOrder)
  const badges = [
    { name: 'First manga', detail: 'Add a manga', achieved: manga.some(item => !item.sample) },
    { name: 'Chapter ten', detail: 'Reach chapter 10', achieved: manga.some(item => !item.sample && item.chapter >= 10) },
    { name: 'The finisher', detail: 'Complete a manga', achieved: manga.some(item => !item.sample && item.status === 'Completed') },
    { name: 'Curator', detail: 'Create a collection', achieved: collections.length > 0 },
    { name: 'Second read', detail: 'Start a reread', achieved: manga.some(item => (item.rereads ?? 0) > 0 && !item.sample) },
    { name: 'Gallery keeper', detail: 'Upload five gallery images', achieved: artwork.filter(item => item.kind === 'gallery' && item.image instanceof Blob).length >= 5 },
  ]
  const achieved = badges.filter(badge => badge.achieved && !options?.earned.includes(badge.name)).map(badge => badge.name).join('|')

  useEffect(() => {
    if (options !== null) return
    const theme = localStorage.getItem('yomari-theme') === 'dark' ? 'dark' : 'light'
    const layout = localStorage.getItem('yomari-layout') === 'list' ? 'list' : 'grid'
    void db.options.add({ id: 'preferences', preferences: { ...defaultPreferences, theme, layout }, earned: [] }).catch(error => {
      if (error.name !== 'ConstraintError') setMessage('Could not initialize settings.')
    })
  }, [options])
  useEffect(() => {
    if (!options || opened.current) return
    opened.current = true
    setView(prefs.hiddenPages.includes(prefs.startPage) ? 'Library' : prefs.startPage)
  }, [options, prefs])
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = prefs.theme
    root.dataset.artwork = prefs.monochrome ? 'monochrome' : 'color'
    root.dataset.cards = prefs.cardStyle
    root.style.setProperty('--accent', prefs.accent || 'var(--ink)')
  }, [prefs])
  useEffect(() => {
    if (!options || !achieved) return
    void updateOptions(current => ({ ...current, earned: [...new Set([...current.earned, ...achieved.split('|')])] })).catch(() => undefined)
  }, [options, achieved])
  useEffect(() => {
    if (!options) return
    const key = `${prefs.language}:${signature}`
    function check() {
      if (checkKey.current === key || !navigator.onLine) return
      checkKey.current = key
      void refreshChapters(tracked, false)
    }
    check()
    window.addEventListener('online', check)
    return () => window.removeEventListener('online', check)
  }, [Boolean(options), prefs.language, signature])

  async function changePreferences(patch: Partial<Preferences>) {
    try { await updateOptions(current => ({ ...current, preferences: { ...current.preferences, ...patch } })) }
    catch { setMessage('Could not save settings.') }
  }

  async function refreshChapters(items: Manga[], report: boolean) {
    const run = ++checkRun.current
    setChecking(true)
    if (report) setMessage('')
    let failed = 0
    const sources = [...items]
    for (const item of sources) {
      if (checkRun.current !== run) return
      try {
        await checkMangaChapters(item, prefs.language)
      } catch { failed++ }
      if (sources.length > 1) await new Promise(resolve => setTimeout(resolve, 220))
    }
    if (checkRun.current !== run) return
    if (report) setMessage(failed ? `Checked ${sources.length - failed} of ${sources.length} titles.` : 'Chapter check complete.')
    setChecking(false)
  }

  function navigate(next: View) {
    opened.current = true
    setView(next)
    setCollectionId(undefined)
    setMessage('')
    setQuery('')
    setFilter('All')
    setScope('active')
    setTag('')
  }

  const shown = manga.filter(item => {
    if (collectionId && !item.collections.includes(collectionId)) return false
    if (scope === 'archived' ? !item.archived : item.archived) return false
    if (scope === 'favorites' && !item.favorite) return false
    if (tag && !item.tags.includes(tag)) return false
    if (filter !== 'All' && item.status !== filter) return false
    return [titleOf(item), item.title, item.author, ...item.tags, ...(item.genres ?? [])].join(' ').toLowerCase().includes(query.trim().toLowerCase())
  })
  if (sort === 'title') shown.sort((a, b) => titleOf(a).localeCompare(titleOf(b)))
  if (sort === 'progress') shown.sort((a, b) => b.chapter - a.chapter)
  if (sort === 'rating') shown.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
  if (sort === 'read') shown.sort((a, b) => (b.readAt ?? 0) - (a.readAt ?? 0))

  async function discover() {
    setDiscovering(true)
    setMessage('')
    try {
      const known = new Set(manga.map(item => item.title.trim().toLowerCase()))
      const saved = new Set(manga.map(item => item.sourceKey))
      const results = []
      for (const genre of discoveryCategories.slice(0, 3)) {
        for (const item of await discoverManga(genre)) {
          const title = item.title.trim().toLowerCase()
          if (known.has(title) || saved.has(`${item.source}:${item.id}`)) continue
          known.add(title)
          results.push(item)
        }
        if (results.length >= 4) break
      }
      setSuggestions(results.slice(0, 6))
    } catch { setMessage('Could not load recommendations from Kitsu.') }
    finally { setDiscovering(false) }
  }

  function shelf(items: Manga[]) {
    if (items.length === 0) return <div className="empty"><BookOpen size={32} strokeWidth={1.25} /><p>{manga.length && !collectionId ? 'No matches' : 'No manga yet'}</p></div>
    return <div className={`shelf shelf-${layout}`}>{items.map(item => <button className="manga-card" key={item.id} onClick={() => setSelected(item.id)}>
      <span className="cover"><Art image={item.primary ? coverById.get(item.primary)?.image : undefined} /><span className="cover-status">{item.status}</span></span>
      <span className="card-info"><strong>{item.favorite && <Star size={13} fill="currentColor" aria-label="Favorite" />} {titleOf(item)}</strong><span className="author">{item.author || ' '}</span><span className="chapter">{item.chapter ? `Ch. ${item.chapter}${item.latest && (item.latestLanguage ?? 'en') === prefs.language ? ` / ${item.latest}` : ''}` : 'Unread'}{hasUpdate(item, prefs.language) && <span className="new-label">New</span>}</span></span>
    </button>)}</div>
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate('Library')}><span className="brand-icon"><BookOpen size={19} /></span>Yomari<span className="brand-period">.</span></button>
      <nav aria-label="Main">{navigation.filter(([, name]) => !prefs.hiddenPages.includes(name) || name === 'Library' || name === 'Settings').map(([Icon, name]) => <button key={name} aria-label={name} title={name} aria-current={view === name ? 'page' : undefined} onClick={() => navigate(name)}><Icon size={18} strokeWidth={1.7} /><span>{name}</span></button>)}</nav>
      <span className="local"><HardDrive size={15} /> On this device</span>
    </aside>
    <main>
      <header className="topbar"><span>{activeCollection ? 'Collections / ' : ''}{activeCollection?.name ?? view}</span><button className="solid" onClick={() => setAdding(true)}><Plus size={17} /> Add manga</button></header>
      <div className="content">
        <div className="page-heading"><h1>{activeCollection?.name ?? (view === 'Library' ? 'My library' : view)}</h1>
          {view === 'Library' && tracked.length > 0 && <button disabled={checking} onClick={() => void refreshChapters(tracked, true)}><RotateCw size={15} /> {checking ? 'Checking…' : 'Check chapters'}</button>}
          {view === 'Collections' && (activeCollection ? <button onClick={() => setCollectionEditor('edit')}>Edit collection</button> : <button onClick={() => setCollectionEditor('new')}><Plus size={16} /> New collection</button>)}
        </div>
        {message && <p role="status" className="muted">{message}</p>}
        {view === 'Library' && <>
          {prefs.showStats && <div className="stats">{(['All', 'Reading', 'Completed', 'Plan to read'] as const).map(status => <button className="stat" key={status} onClick={() => { setScope('active'); setFilter(status) }}><span>{status === 'All' ? 'Total manga' : status}</span><strong>{status === 'All' ? active.length : active.filter(item => item.status === status).length}</strong></button>)}</div>}
          {prefs.showUpdates && tracked.length > 0 && <section className="dashboard-section"><div className="section-heading"><h2>Updates available</h2><span className="muted">{updates.length}</span></div>{updates.length ? <div className="update-list">{updates.map(item => <button key={item.id} onClick={() => setSelected(item.id)}><strong>{titleOf(item)}</strong><span>Ch. {item.latest}</span></button>)}</div> : <p className="muted">{checking ? 'Checking…' : 'No chapter updates'}</p>}</section>}
          <div className="library-heading"><h2>{scope === 'favorites' ? 'Favorites' : scope === 'archived' ? 'Archive' : 'All manga'}</h2><span>{shown.length} {shown.length === 1 ? 'title' : 'titles'}</span></div>
          <div className="toolbar"><div className="filters" aria-label="Filter by status">{['All', ...includedStatuses].filter((status, index, all) => all.indexOf(status) === index).map(status => <button key={status} aria-pressed={filter === status} onClick={() => setFilter(status)}>{status}</button>)}</div>
            <div className="tools">
              <label className="search"><Search size={16} /><input aria-label="Search library" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} /></label>
              <select aria-label="Library scope" value={scope} onChange={event => setScope(event.target.value)}><option value="active">Library</option><option value="favorites">Favorites</option><option value="archived">Archive</option></select>
              {tags.length > 0 && <select aria-label="Filter by tag" value={tag} onChange={event => setTag(event.target.value)}><option value="">All tags</option>{tags.map(name => <option key={name}>{name}</option>)}</select>}
              <select aria-label="Sort library" value={sort} onChange={event => setSort(event.target.value)}><option value="recent">Recently added</option><option value="title">Title</option><option value="progress">Progress</option><option value="rating">Rating</option><option value="read">Last read</option></select>
              <div className="layout"><button aria-label="Grid view" aria-pressed={layout !== 'list'} onClick={() => void changePreferences({ layout: 'grid' })}><Grid2X2 size={16} /></button><button aria-label="List view" aria-pressed={layout === 'list'} onClick={() => void changePreferences({ layout: 'list' })}><List size={17} /></button></div>
            </div>
          </div>
          {shelf(shown)}
          {prefs.showRecommendations && (recommendations.length > 0 || discoveryCategories.length > 0) && <section className="dashboard-section">
            <div className="section-heading"><h2>Recommendations</h2>{discoveryCategories.length > 0 && <button disabled={discovering} onClick={() => void discover()}>{discovering ? 'Loading…' : 'Discover on Kitsu'}</button>}</div>
            {recommendations.length > 0 && <div className="update-list">{recommendations.map(item => <button key={item.id} onClick={() => setSelected(item.id)}><strong>{titleOf(item)}</strong><span>On your list</span></button>)}</div>}
            {suggestions && <div className="results">{suggestions.length === 0 && <p>No new recommendations.</p>}{suggestions.filter(item => !manga.some(saved => saved.sourceKey === `${item.source}:${item.id}`)).map(item => <button key={item.id} disabled={discovering} onClick={async () => {
              setDiscovering(true)
              try { setSelected(await addTitle(item.title, item.author, item)) }
              catch { setMessage('Could not save recommendation.') }
              finally { setDiscovering(false) }
            }}><span className="result-art"><Art image={item.cover} /></span><span><strong>{item.title}</strong><small>{item.author}</small></span><Plus size={16} /></button>)}</div>}
          </section>}
        </>}
        {view === 'Collections' && (activeCollection ? <><button className="back" onClick={() => setCollectionId(undefined)}>All collections</button>{shelf(shown)}</> : collections.length ? <div className="tiles">{collections.map(collection => <button className="tile" key={collection.id} onClick={() => setCollectionId(collection.id)}><Layers size={25} /><strong>{collection.name}</strong><span>{manga.filter(item => item.collections.includes(collection.id)).length} titles</span></button>)}</div> : <div className="empty"><Layers size={32} strokeWidth={1.25} /><p>No collections yet</p></div>)}
        {view === 'Gallery' && <>
          <div className="tools"><select aria-label="Filter gallery" value={galleryFilter} onChange={event => setGalleryFilter(event.target.value)}><option value="all">All images</option><option value="cover">Covers</option><option value="gallery">Gallery uploads</option></select>
            <select aria-label="Filter images by manga" value={galleryTitle} onChange={event => setGalleryTitle(event.target.value)}><option value="">All manga</option>{manga.filter(item => artwork.some(art => art.mangaId === item.id)).map(item => <option value={item.id} key={item.id}>{titleOf(item)}</option>)}</select>
            <ArtworkSort value={galleryOrder} onChange={setGalleryOrder} />
          </div>
          <div className="art-grid global-gallery">{gallery.map(item => <button className="cover-choice" key={item.id} onClick={() => setImageId(item.id)}><span className="mini-cover"><Art image={item.image} /></span><strong>{mangaById.has(item.mangaId) ? titleOf(mangaById.get(item.mangaId)!) : item.label}</strong>{item.caption && <span className="caption">{item.caption}</span>}</button>)}</div>
          {gallery.length === 0 && <div className="empty"><Images size={32} strokeWidth={1.25} /><p>No images yet</p></div>}
        </>}
        {view === 'Badges' && <div className="tiles">{badges.map(badge => {
          const earned = badge.achieved || options?.earned.includes(badge.name)
          return <div className={`tile ${earned ? 'earned' : ''}`} key={badge.name}><Trophy size={25} /><strong>{badge.name}</strong><span>{earned ? 'Earned' : badge.detail}</span></div>
        })}</div>}
        {view === 'Settings' && <SettingsPanel prefs={prefs} change={changePreferences} artwork={artwork} statusNames={manga.map(item => item.status)} removeSamples={manga.some(item => item.sample) ? () => removeManga(manga.filter(item => item.sample).map(item => item.id)) : undefined} />}
      </div>
    </main>
    {adding && <AddManga close={() => setAdding(false)} open={id => { navigate('Library'); setSelected(id) }} />}
    {detail && <MangaDetail key={detail.id} manga={detail} close={() => setSelected(undefined)} open={setSelected} openImage={setImageId} prefs={prefs} />}
    {lightbox && <ImageDetail key={lightbox.id} item={lightbox} close={() => setImageId(undefined)} />}
    {collectionEditor && <CollectionEditor collection={collectionEditor === 'edit' ? activeCollection : undefined} close={() => setCollectionEditor(undefined)} open={setCollectionId} />}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
