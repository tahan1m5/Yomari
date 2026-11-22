import { useEffect, useState } from 'react'
import { exportBackup, readBackup, restoreBackup } from './backup'
import { pages, statuses, type Artwork, type Preferences } from './library'

interface InstallPrompt extends Event {
  prompt(): Promise<unknown>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let installPrompt: InstallPrompt | undefined
if (import.meta.env.PROD) {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    installPrompt = event as InstallPrompt
  })
}

export function SettingsPanel({ prefs, change, artwork, statusNames, removeSamples }: {
  prefs: Preferences; change: (patch: Partial<Preferences>) => Promise<void>; artwork: Artwork[]
  statusNames: string[]; removeSamples?: () => Promise<void>
}) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [storage, setStorage] = useState<{ quota?: number; usage?: number; persistent?: boolean }>({})
  const [newStatus, setNewStatus] = useState('')
  const [installed, setInstalled] = useState(() => matchMedia('(display-mode: standalone)').matches)
  const [canInstall, setCanInstall] = useState(Boolean(installPrompt))
  const artworkBytes = artwork.reduce((total, item) => total + (item.image instanceof Blob ? item.image.size : 0), 0)
  const size = (bytes: number) => `${(bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB`

  async function estimate() {
    const estimate = await navigator.storage?.estimate?.()
    const persistent = await navigator.storage?.persisted?.()
    setStorage({ ...estimate, persistent })
  }

  useEffect(() => {
    void estimate().catch(() => undefined)
    const available = () => setCanInstall(true)
    const complete = () => { installPrompt = undefined; setCanInstall(false); setInstalled(true) }
    if (import.meta.env.PROD) window.addEventListener('beforeinstallprompt', available)
    window.addEventListener('appinstalled', complete)
    return () => {
      window.removeEventListener('beforeinstallprompt', available)
      window.removeEventListener('appinstalled', complete)
    }
  }, [artworkBytes])

  async function run(action: () => Promise<void>, success?: string) {
    setBusy(true)
    setMessage('')
    try { await action(); if (success) setMessage(success) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not complete action.') }
    finally { setBusy(false) }
  }

  function toggle(key: 'monochrome' | 'showStats' | 'showUpdates' | 'showRecommendations' | 'compress', label: string) {
    return <label>{label}<input type="checkbox" checked={prefs[key]} onChange={event => void change({ [key]: event.target.checked })} /></label>
  }

  return <div className="settings-groups">
    <section className="settings"><h2>Appearance</h2>
      <label>Theme<select value={prefs.theme} onChange={event => void change({ theme: event.target.value as Preferences['theme'] })}><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select></label>
      <label>Library layout<select value={prefs.layout} onChange={event => void change({ layout: event.target.value as Preferences['layout'] })}><option value="grid">Grid</option><option value="compact">Compact</option><option value="list">List</option></select></label>
      <label>Card corners<select value={prefs.cardStyle} onChange={event => void change({ cardStyle: event.target.value as Preferences['cardStyle'] })}><option value="rounded">Rounded</option><option value="square">Square</option></select></label>
      <div><label htmlFor="accent">Accent color</label><div className="actions"><input id="accent" type="color" value={prefs.accent || '#171717'} onChange={event => void change({ accent: event.target.value })} /><button disabled={!prefs.accent} onClick={() => void change({ accent: '' })}>Reset</button></div></div>
      {toggle('monochrome', 'Black-and-white artwork')}
    </section>
    <section className="settings"><h2>Dashboard</h2>{toggle('showStats', 'Library summary')}{toggle('showUpdates', 'Chapter updates')}{toggle('showRecommendations', 'Recommendations')}
      <label>Start page<select value={prefs.startPage} onChange={event => void change({ startPage: event.target.value as Preferences['startPage'] })}>{pages.filter(page => !prefs.hiddenPages.includes(page)).map(page => <option key={page}>{page}</option>)}</select></label>
      <div><span>Navigation</span><div className="navigation-options">{(['Collections', 'Gallery', 'Badges'] as const).map(page => <label key={page}><input type="checkbox" checked={!prefs.hiddenPages.includes(page)} onChange={event => void change({
        hiddenPages: event.target.checked ? prefs.hiddenPages.filter(hidden => hidden !== page) : [...prefs.hiddenPages, page],
        startPage: !event.target.checked && prefs.startPage === page ? 'Library' : prefs.startPage,
      })} />{page}</label>)}</div></div>
    </section>
    <section className="settings"><h2>Tracking</h2>
      <label>Chapter language<select value={prefs.language} onChange={event => void change({ language: event.target.value })}>{[['en', 'English'], ['ja', 'Japanese'], ['fr', 'French'], ['es', 'Spanish'], ['es-la', 'Latin American Spanish'], ['pt-br', 'Brazilian Portuguese'], ['id', 'Indonesian']].map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
      <form onSubmit={event => {
        event.preventDefault()
        const name = newStatus.trim()
        if (!name || [...statuses, 'All', ...prefs.customStatuses].some(status => status.toLowerCase() === name.toLowerCase())) { setMessage('Choose a unique status.'); return }
        void run(async () => { await change({ customStatuses: [...prefs.customStatuses, name] }); setNewStatus('') }, 'Status added.')
      }}><label htmlFor="new-status">Custom status</label><div className="actions"><input id="new-status" maxLength={32} value={newStatus} onChange={event => setNewStatus(event.target.value)} /><button disabled={busy}>Add</button></div></form>
      {prefs.customStatuses.length > 0 && <div className="status-options">{prefs.customStatuses.map(status => <button key={status} disabled={statusNames.includes(status)} title={statusNames.includes(status) ? 'In use by your library' : undefined} onClick={() => void change({ customStatuses: prefs.customStatuses.filter(name => name !== status) })}>{status} ×</button>)}</div>}
    </section>
    <section className="settings"><h2>Data</h2>
      <div><span>Backup</span><div className="actions"><button disabled={busy} onClick={() => void run(exportBackup, 'Backup exported.')}>Export</button><label className="button">Restore<input className="visually-hidden" type="file" accept=".json,application/json" disabled={busy} onChange={event => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (!file) return
        void run(async () => {
          const backup = await readBackup(file)
          if (!confirm(`Replace this library and its settings with the backup’s ${backup.manga.length} titles?`)) return
          await restoreBackup(backup)
          setMessage('Backup restored.')
        })
      }} /></label></div></div>
      {toggle('compress', 'Compress new JPEG and PNG uploads')}
      <div><span>Stored images</span><span>{size(artworkBytes)}</span></div>
      {storage.usage !== undefined && <div><span>Browser storage</span><span>{size(storage.usage)}{storage.quota !== undefined ? ` / ${size(storage.quota)}` : ''}</span></div>}
      {navigator.storage?.persist && <div><span>Storage retention</span><button disabled={busy || storage.persistent} onClick={() => void run(async () => {
        const granted = await navigator.storage.persist()
        await estimate()
        setMessage(granted ? 'Persistent storage enabled.' : 'Browser did not grant persistent storage.')
      })}>{storage.persistent ? 'Persistent' : 'Request persistence'}</button></div>}
      {removeSamples && <div><span>Sample library</span><button disabled={busy} onClick={() => { if (confirm('Remove all sample manga?')) void run(removeSamples) }}>Remove samples</button></div>}
    </section>
    <section className="settings"><h2>App</h2><div><span>Yomari PWA</span>{installed ? <span>Installed</span> : canInstall ? <button onClick={() => void run(async () => {
      if (!installPrompt) return
      await installPrompt.prompt()
      const choice = await installPrompt.userChoice
      installPrompt = undefined
      setCanInstall(false)
      setInstalled(choice.outcome === 'accepted')
    })}>Install</button> : <span className="muted">Use your browser’s install menu</span>}</div></section>
    {message && <p role="status" className="settings-message">{message}</p>}
  </div>
}
