# Yomari

A local-first manga tracker. Your library and uploads are stored in IndexedDB in the browser. Catalog search, remote covers, and chapter checks use MangaDex.

## Preview

With Node.js 20.19+ or 22.12+, run `npm ci` and `npm run dev`, then open the local URL Vite prints. The dev server reloads the app as you edit.

To try PWA installation and offline loading, run `npm run build` and `npm exec vite preview`. Open the printed localhost URL and load the page online once before testing offline.

The first launch includes a sample shelf. Use **Settings → Remove samples** to start with an empty library.
