import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// dev: `pnpm --filter @codetiller/web dev` + `pnpm tiller ui --api-only`; prod: `tiller ui` serves dist/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4317' } },
})
