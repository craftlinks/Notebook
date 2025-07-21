import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  },
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: 'public/examples',
          dest: 'examples'
        }
      ]
    })
  ]
}) 