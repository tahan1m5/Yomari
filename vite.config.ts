import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  server: { host: '0.0.0.0', allowedHosts: true },
  plugins: [VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['icon-192.png', 'icon-512.png'],
    workbox: { globPatterns: ['**/*.{html,js,css,png,jpg,woff2}'] },
    manifest: {
      name: 'Yomari', short_name: 'Yomari', description: 'A local manga tracker',
      display: 'standalone', start_url: '.', theme_color: '#f8f8f8', background_color: '#f8f8f8',
      icons: [192, 512].map(size => ({ src: `icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png' })),
    },
  })],
})
