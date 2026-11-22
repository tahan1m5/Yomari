import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { useLiveQuery } from 'dexie-react-hooks'
import { BookOpen, LibraryBig, Layers, Images, Settings, Plus, Search, Grid2X2, List, X, ImagePlus, RotateCw, Trophy, HardDrive } from 'lucide-react'
import { db, downloadCover, fetchCovers, latestChapter, removeManga, searchManga, statuses, titleOf, type Artwork, type Manga, type SearchResult, type Status } from './library'
import './style.css'

type View = 'Library' | 'Collections' | 'Gallery' | 'Badges' | 'Settings'
const navigation = [[LibraryBig, 'Library'], [Layers, 'Collections'], [Images, 'Gallery'], [Trophy, 'Badges'], [Settings, 'Settings']] as const

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

function AddManga({ close, open }: { close: () => void; open: (id: string) => void }) {
  const [mode, setMode] = useState<'search' | 'manual'>('search')
  const [query, setQuery] = useState('')
  const [author, setAuthor] = useState('')
  const [results, setResults] = useState<SearchResult[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function add(result?: SearchResult) {
    setBusy(true)
    setError('')
    try {
      const image = result?.cover ? await downloadCover(result.cover) : undefined
      const mangaId = await db.transaction('rw', db.manga, db.artwork, async () => {
        const existing = result && await db.manga.where('sourceId').equals(result.id).first()
        if (existing) return existing.id
        const id = crypto.randomUUID()
        const primary = image ? crypto.randomUUID() : undefined
        await db.manga.add({ id, sourceId: result?.id, title: result?.title || query.trim(), author: result?.author ?? author.trim(), description: result?.description ?? '', status: 'Plan to read', chapter: 0, tags: result?.tags ?? [], collections: [], primary, added: Date.now() })
        if (image && primary) await db.artwork.add({ id: primary, mangaId: id, label: 'Cover', kind: 'cover', image })
        return id
      })
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
    try { setResults(await searchManga(query.trim())) }
    catch { setError('Could not reach MangaDex.') }
    finally { setBusy(false) }
  }

  return <Modal title="Add manga" onClose={close}>
    <div className="tabs"><button aria-pressed={mode === 'search'} disabled={busy} onClick={() => { setMode('search'); setError('') }}>MangaDex</button><button aria-pressed={mode === 'manual'} disabled={busy} onClick={() => { setMode('manual'); setError('') }}>Manual</button></div>
    <form onSubmit={submit} className="form">
      <label>{mode === 'search' ? 'Search title' : 'Title'}<input autoFocus required value={query} onChange={event => setQuery(event.target.value)} /></label>
      {mode === 'manual' && <label>Author<input value={author} onChange={event => setAuthor(event.target.value)} /></label>}
      <button className="solid" disabled={busy}>{busy ? 'Working…' : mode === 'search' ? 'Search' : 'Add manga'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {mode === 'search' && results && <div className="results">{results.length === 0 && <p>No results</p>}{results.map(result => <button key={result.id} disabled={busy} onClick={() => void add(result)}><span className="result-art"><Art image={result.cover} /></span><span><strong>{result.title}</strong><small>{result.author}</small></span><Plus size={16} /></button>)}</div>}
  </Modal>
}

function MangaDetail({ manga, close, open }: { manga: Manga; close: () => void; open: (id: string) => void }) {
  const artwork = useLiveQuery(() => db.artwork.where('mangaId').equals(manga.id).toArray(), [manga.id], [])
  const collections = useLiveQuery(() => db.collections.toArray(), [], [])
  const related = useLiveQuery(async () => (await db.manga.toArray()).filter(item => item.id !== manga.id && manga.tags.some(tag => item.tags.includes(tag))).sort((a, b) => b.tags.filter(tag => manga.tags.includes(tag)).length - a.tags.filter(tag => manga.tags.includes(tag)).length).slice(0, 4), [manga.id, manga.tags.join(',')], [])
  const [covers, setCovers] = useState<Awaited<ReturnType<typeof fetchCovers>>>()
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
      const records = images.map(({ image, label, id }) => ({ id: id ?? crypto.randomUUID(), image, label, mangaId: manga.id, kind }))
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
      await db.manga.update(manga.id, {
        customTitle: title === manga.title ? undefined : title, status: data.get('status') as Status,
        chapter: Number(data.get('chapter')), tags: [...new Set(String(data.get('tags')).split(',').map(tag => tag.trim()).filter(Boolean))],
        notes: String(data.get('notes')), rating: Number(data.get('rating')) || undefined,
        collections: data.getAll('collections').map(String),
      })
      setFeedback('Saved.')
    })
  }

  async function deleteArt(item: Artwork) {
    await db.transaction('rw', db.manga, db.artwork, async () => {
      await db.artwork.delete(item.id)
      const current = await db.manga.get(manga.id)
      if (current?.primary !== item.id) return
      const fallback = await db.artwork.where('mangaId').equals(manga.id).filter(art => art.kind === 'cover').first()
      await db.manga.update(manga.id, { primary: fallback?.id })
    })
  }

  return <Modal title={titleOf(manga)} onClose={close}>
    {manga.author && <p className="muted">{manga.author}{manga.customTitle ? ` · ${manga.title}` : ''}</p>}
    <form className="form" onSubmit={save}>
      <label>Display title<input name="title" required defaultValue={titleOf(manga)} /></label>
      <div className="fields"><label>Status<select name="status" defaultValue={manga.status}>{statuses.map(status => <option key={status}>{status}</option>)}</select></label><label>Last chapter<input name="chapter" type="number" min="0" step="any" required defaultValue={manga.chapter} /></label><label>Rating / 10<input name="rating" type="number" min="1" max="10" defaultValue={manga.rating} /></label></div>
      <label>Tags<input name="tags" defaultValue={manga.tags.join(', ')} placeholder="Separate with commas" /></label>
      <label>Notes<textarea name="notes" defaultValue={manga.notes} /></label>
      {collections.length > 0 && <fieldset><legend>Collections</legend>{collections.map(collection => <label className="check" key={collection.id}><input type="checkbox" name="collections" value={collection.id} defaultChecked={manga.collections.includes(collection.id)} />{collection.name}</label>)}</fieldset>}
      <div className="actions"><button className="solid" disabled={busy}>Save changes</button>{manga.sourceId && <button type="button" disabled={busy} onClick={() => void perform(async () => {
        const latest = await latestChapter(manga.sourceId!)
        if (latest !== undefined) await db.manga.update(manga.id, { latest })
        setFeedback(latest === undefined ? 'No chapters found.' : `Latest chapter: ${latest}`)
      })}><RotateCw size={15} /> Check chapters</button>}</div>
      {feedback && <p role="status" className="muted">{feedback}</p>}
    </form>
    {(['cover', 'gallery'] as const).map(kind => <section className="detail-section" key={kind}>
      <div className="section-heading"><h3>{kind === 'cover' ? 'Covers' : 'Gallery'}</h3><div className="actions">
        <label className="button"><ImagePlus size={16} /> Upload<input className="visually-hidden" type="file" accept="image/*" multiple disabled={busy} onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []).filter(file => file.type.startsWith('image/'))
          event.currentTarget.value = ''
          void perform(() => addArtwork(files.map(image => ({ image, label: image.name })), kind))
        }} /></label>
        {kind === 'cover' && manga.sourceId && <button disabled={busy} onClick={() => void perform(async () => { setCovers(await fetchCovers(manga.sourceId!)) })}>MangaDex</button>}
      </div></div>
      <div className="art-grid">{artwork.filter(item => item.kind === kind).map(item => <div key={item.id}><div className="mini-cover"><Art image={item.image} alt={item.label} /></div><div className="art-actions">{kind === 'cover' && <button disabled={busy || manga.primary === item.id} onClick={() => void perform(() => db.manga.update(manga.id, { primary: item.id }))}>{manga.primary === item.id ? 'Primary' : 'Set primary'}</button>}<button disabled={busy} aria-label={`Remove ${item.label}`} onClick={() => void perform(() => deleteArt(item))}><X size={14} /></button></div></div>)}</div>
      {kind === 'cover' && covers && <div className="art-grid">{covers.length === 0 && <p>No covers found.</p>}{covers.map(cover => {
        const id = `${manga.id}-${cover.id}`
        return <button key={cover.id} className="cover-choice" disabled={busy || artwork.some(item => item.id === id)} onClick={() => void perform(async () => {
          await addArtwork([{ id, image: await downloadCover(cover.url), label: cover.label }], 'cover')
        })}><span className="mini-cover"><Art image={cover.url} /></span>{cover.label}</button>
      })}</div>}
    </section>)}
    {manga.description && <section className="detail-section"><h3>Synopsis</h3><p className="muted">{manga.description}</p></section>}
    {related.length > 0 && <section className="detail-section"><h3>Similar in your library</h3><div className="actions">{related.map(item => <button key={item.id} onClick={() => open(item.id)}>{titleOf(item)}</button>)}</div></section>}
    <section className="detail-section"><button disabled={busy} onClick={() => { if (confirm(`Remove ${titleOf(manga)} and its images?`)) void perform(async () => { await removeManga([manga.id]); close() }) }}>Remove manga</button></section>
  </Modal>
}

function App() {
  const manga = useLiveQuery(() => db.manga.orderBy('added').reverse().toArray(), [], [])
  const artwork = useLiveQuery(() => db.artwork.toArray(), [], [])
  const collections = useLiveQuery(() => db.collections.toArray(), [], [])
  const [view, setView] = useState<View>('Library')
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [filter, setFilter] = useState<Status | 'All'>('All')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('recent')
  const [layout, setLayout] = useState(() => localStorage.getItem('yomari-layout') || 'grid')
  const [theme, setTheme] = useState(() => localStorage.getItem('yomari-theme') || 'light')
  const [collectionId, setCollectionId] = useState<string>()
  const [creatingCollection, setCreatingCollection] = useState(false)
  const [lightbox, setLightbox] = useState<Artwork>()
  const [galleryFilter, setGalleryFilter] = useState('all')
  const [message, setMessage] = useState('')
  const [checking, setChecking] = useState(false)
  const initialCheck = useRef(false)
  const coverById = new Map(artwork.map(item => [item.id, item]))
  const mangaById = new Map(manga.map(item => [item.id, item]))
  const detail = selected ? mangaById.get(selected) : undefined
  const activeCollection = collections.find(collection => collection.id === collectionId)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('yomari-theme', theme)
  }, [theme])
  useEffect(() => { localStorage.setItem('yomari-layout', layout) }, [layout])
  useEffect(() => {
    if (!manga.some(item => item.sourceId) || initialCheck.current) return
    initialCheck.current = true
    if (navigator.onLine) void refreshChapters(manga, false)
  }, [manga])

  async function refreshChapters(items: Manga[], report: boolean) {
    setChecking(true)
    if (report) setMessage('')
    let failed = 0
    const sources = items.filter(item => item.sourceId && item.status !== 'Dropped')
    for (const item of sources) {
      try {
        const latest = await latestChapter(item.sourceId!)
        if (latest !== undefined) await db.manga.update(item.id, { latest })
      } catch { failed++ }
      if (sources.length > 1) await new Promise(resolve => setTimeout(resolve, 220))
    }
    if (report) setMessage(failed ? `Checked ${sources.length - failed} of ${sources.length} titles.` : 'Chapter check complete.')
    setChecking(false)
  }

  function navigate(next: View) {
    setView(next)
    setCollectionId(undefined)
    setMessage('')
    setQuery('')
    setFilter('All')
  }

  const shown = manga.filter(item => {
    if (collectionId && !item.collections.includes(collectionId)) return false
    if (filter !== 'All' && item.status !== filter) return false
    return [titleOf(item), item.title, item.author, ...item.tags].join(' ').toLowerCase().includes(query.trim().toLowerCase())
  })
  if (sort === 'title') shown.sort((a, b) => titleOf(a).localeCompare(titleOf(b)))
  if (sort === 'progress') shown.sort((a, b) => b.chapter - a.chapter)

  function shelf(items: Manga[]) {
    if (items.length === 0) return <div className="empty"><BookOpen size={32} strokeWidth={1.25} /><p>{manga.length && !collectionId ? 'No matches' : 'No manga yet'}</p>{manga.length === 0 && <button className="solid" onClick={() => setAdding(true)}><Plus size={16} /> Add manga</button>}</div>
    return <div className={`shelf ${layout === 'list' ? 'shelf-list' : ''}`}>{items.map(item => <button className="manga-card" key={item.id} onClick={() => setSelected(item.id)}>
      <span className="cover"><Art image={item.primary ? coverById.get(item.primary)?.image : undefined} /><span className="cover-status">{item.status}</span></span>
      <span className="card-info"><strong>{titleOf(item)}</strong><span className="author">{item.author || ' '}</span><span className="chapter">{item.chapter ? `Ch. ${item.chapter}${item.latest ? ` / ${item.latest}` : ''}` : 'Unread'}{item.sourceId && (item.latest ?? 0) > item.chapter && <span className="new-label">New</span>}</span></span>
    </button>)}</div>
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate('Library')}><span className="brand-icon"><BookOpen size={19} /></span>Yomari<span className="brand-period">.</span></button>
      <nav aria-label="Main">{navigation.map(([Icon, name]) => <button key={name} aria-label={name} title={name} aria-current={view === name ? 'page' : undefined} onClick={() => navigate(name)}><Icon size={18} strokeWidth={1.7} /><span>{name}</span></button>)}</nav>
      <span className="local"><HardDrive size={15} /> On this device</span>
    </aside>
    <main>
      <header className="topbar"><span>{activeCollection ? 'Collections / ' : ''}{activeCollection?.name ?? view}</span><button className="solid" onClick={() => setAdding(true)}><Plus size={17} /> Add manga</button></header>
      <div className="content">
        <div className="page-heading"><h1>{activeCollection?.name ?? (view === 'Library' ? 'My library' : view)}</h1>
          {view === 'Library' && manga.some(item => item.sourceId) && <button disabled={checking} onClick={() => void refreshChapters(manga, true)}><RotateCw size={15} /> {checking ? 'Checking…' : 'Check chapters'}</button>}
          {view === 'Collections' && <button onClick={() => setCreatingCollection(true)}><Plus size={16} /> New collection</button>}
        </div>
        {message && <p role="status" className="muted">{message}</p>}
        {view === 'Library' && <>
          <div className="stats">{(['All', 'Reading', 'Completed', 'Plan to read'] as const).map(status => <button className="stat" key={status} onClick={() => setFilter(status)}><span>{status === 'All' ? 'Total manga' : status}</span><strong>{status === 'All' ? manga.length : manga.filter(item => item.status === status).length}</strong></button>)}</div>
          <div className="library-heading"><h2>All manga</h2><span>{shown.length} {shown.length === 1 ? 'title' : 'titles'}</span></div>
          <div className="toolbar"><div className="filters" aria-label="Filter by status">{(['All', ...statuses] as const).map(status => <button key={status} aria-pressed={filter === status} onClick={() => setFilter(status)}>{status}</button>)}</div>
            <div className="tools"><label className="search"><Search size={16} /><input aria-label="Search library" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} /></label><select aria-label="Sort library" value={sort} onChange={event => setSort(event.target.value)}><option value="recent">Recently added</option><option value="title">Title</option><option value="progress">Progress</option></select><div className="layout"><button aria-label="Grid view" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><Grid2X2 size={16} /></button><button aria-label="List view" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List size={17} /></button></div></div>
          </div>
          {shelf(shown)}
        </>}
        {view === 'Collections' && (activeCollection ? <><button className="back" onClick={() => setCollectionId(undefined)}>All collections</button>{shelf(shown)}</> : collections.length ? <div className="tiles">{collections.map(collection => <button className="tile" key={collection.id} onClick={() => setCollectionId(collection.id)}><Layers size={25} /><strong>{collection.name}</strong><span>{manga.filter(item => item.collections.includes(collection.id)).length} titles</span></button>)}</div> : <div className="empty"><Layers size={32} strokeWidth={1.25} /><p>No collections yet</p></div>)}
        {view === 'Gallery' && <><select aria-label="Filter gallery" value={galleryFilter} onChange={event => setGalleryFilter(event.target.value)}><option value="all">All images</option><option value="cover">Covers</option><option value="gallery">Gallery uploads</option></select><div className="art-grid global-gallery">{artwork.filter(item => galleryFilter === 'all' || item.kind === galleryFilter).map(item => <button className="cover-choice" key={item.id} onClick={() => setLightbox(item)}><span className="mini-cover"><Art image={item.image} alt={item.label} /></span>{mangaById.has(item.mangaId) ? titleOf(mangaById.get(item.mangaId)!) : item.label}</button>)}</div>{!artwork.some(item => galleryFilter === 'all' || item.kind === galleryFilter) && <div className="empty"><Images size={32} strokeWidth={1.25} /><p>No images yet</p></div>}</>}
        {view === 'Badges' && <div className="tiles">{[
          { name: 'First manga', detail: 'Add a manga', earned: manga.some(item => !item.sample) },
          { name: 'Chapter ten', detail: 'Reach chapter 10', earned: manga.some(item => !item.sample && item.chapter >= 10) },
          { name: 'The finisher', detail: 'Complete a manga', earned: manga.some(item => !item.sample && item.status === 'Completed') },
          { name: 'Curator', detail: 'Create a collection', earned: collections.length > 0 },
        ].map(badge => <div className={`tile ${badge.earned ? 'earned' : ''}`} key={badge.name}><Trophy size={25} /><strong>{badge.name}</strong><span>{badge.earned ? 'Earned' : badge.detail}</span></div>)}</div>}
        {view === 'Settings' && <div className="settings"><label>Theme<select value={theme} onChange={event => setTheme(event.target.value)}><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Library layout<select value={layout} onChange={event => setLayout(event.target.value)}><option value="grid">Grid</option><option value="list">List</option></select></label>{manga.some(item => item.sample) && <div><span>Sample library</span><button onClick={async () => {
          if (!confirm('Remove all sample manga?')) return
          try { await removeManga(manga.filter(item => item.sample).map(item => item.id)) }
          catch { setMessage('Could not remove sample manga.') }
        }}>Remove samples</button></div>}</div>}
      </div>
    </main>
    {adding && <AddManga close={() => setAdding(false)} open={id => { navigate('Library'); setSelected(id) }} />}
    {detail && <MangaDetail key={detail.id} manga={detail} close={() => setSelected(undefined)} open={setSelected} />}
    {lightbox && <Modal title={lightbox.label} onClose={() => setLightbox(undefined)}><div className="lightbox"><Art image={lightbox.image} alt={lightbox.label} /></div></Modal>}
    {creatingCollection && <Modal title="New collection" onClose={() => setCreatingCollection(false)}><form className="form" onSubmit={async event => {
      event.preventDefault()
      const name = String(new FormData(event.currentTarget).get('name')).trim()
      if (!name) return
      try {
        const id = crypto.randomUUID()
        await db.collections.add({ id, name })
        setCreatingCollection(false)
        setCollectionId(id)
      } catch { setMessage('Could not create collection.') }
    }}><label>Name<input name="name" autoFocus required /></label><button className="solid">Create collection</button></form></Modal>}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
