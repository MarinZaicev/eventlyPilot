import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  server: {
    host: '0.0.0.0',

    allowedHosts: [
      '.trycloudflare.com',
    ],

    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },

      '/media': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },

      '/health': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },

  // Боевой режим: `vite build` + `vite preview`.
  // Прокси (/api, /media, /health), host и allowedHosts берутся из server,
  // порт тот же, что у dev — туннель Cloudflare менять не нужно.
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
})
