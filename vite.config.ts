import { defineConfig } from 'vite'

// base: './' keeps the build working when the static host serves it from a
// sub-path (e.g. https://host/studio/abc123/). Routing is hash-based, so no
// server-side rewrite rules are required.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
})
