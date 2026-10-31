import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { fileURLToPath } from 'node:url'

// The cloudflare plugin runs worker/index.ts inside the dev server against local
// D1 and R2, so `npm run dev` is the whole stack.
export default defineConfig({
  // E2E=1 (set by playwright.config.ts) points D1/R2 at .wrangler/e2e so tests never touch the developer's local data.
  plugins: [react(), tailwindcss(), cloudflare(process.env.E2E ? { persistState: { path: '.wrangler/e2e' } } : {})],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
})
