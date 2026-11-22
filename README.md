# Yomari

A local-first manga tracker. Your library, progress, settings, and uploads are stored in IndexedDB in the browser.

- Search MangaDex, Kitsu, and MyAnimeList through Jikan. Individual catalog errors leave results from the other sources available.
- Chapter checks use MangaDex. Link a MangaDex title from an entry’s reading history to follow chapters for a Kitsu, MyAnimeList, or manual entry. Set the chapter language in **Settings**.
- **Settings → Export** saves a JSON backup. **Restore** validates a backup before asking whether to replace the current library and settings. Backups embed locally stored images. An image that the source only allows Yomari to display is backed up as its original URL.
- **Settings → Data** shows local image usage, lets you request persistent browser storage, and controls compression of new JPEG and PNG uploads.

## Preview

With Node.js 20.19+ or 22.12+, run `npm ci` and `npm run dev`, then open the local URL Vite prints. The dev server reloads the app as you edit.

To try PWA installation and offline loading, run `npm run build` and `npm exec vite preview`. Open the printed localhost URL and load the page online once before testing offline.

The first launch includes a sample shelf. Use **Settings → Remove samples** to start with an empty library.
