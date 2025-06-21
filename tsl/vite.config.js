import { defineConfig } from 'vite'

export default defineConfig({
  base: '/tsl/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  }
})