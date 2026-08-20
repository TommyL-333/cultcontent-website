import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/ccc-network/',
  plugins: [react(), tailwindcss()],
  server: {
    // Dev-only convenience: proxy API calls to the real Express server so
    // `npm run dev` can hot-reload against live data. Not the verified path —
    // production (and this feature's actual verification) is `vite build`
    // output served directly by Express, which owns real request routing.
    proxy: {
      '^/ccc-network/(signup|login|logout|auth/.*|connect/.*|contacts\\.csv)': { target: 'http://localhost:39281', changeOrigin: true },
      '/api/ccc-network': 'http://localhost:39281',
    },
  },
})
