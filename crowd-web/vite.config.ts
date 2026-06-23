import { defineConfig } from 'vite'

/** crowd-web is served from the aggregator under `/crowd/`, so the
 * production build is prefixed; in dev the aggregator proxies straight
 * through. The aggregator already mounts the `/c/{code}` route, so the
 * HTML is the same regardless of room code. */
export default defineConfig({
  base: '/crowd/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
})
