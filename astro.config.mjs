// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import remarkMath from 'remark-math';
import rehypeMathjax from 'rehype-mathjax/svg';

// https://astro.build/config
export default defineConfig({
  // Add MDX integration with math support
  integrations: [
    mdx({
      remarkPlugins: [remarkMath],
      rehypePlugins: [rehypeMathjax],
    })
  ],

  site: 'https://www.craftlinks.art/Notebook/',
  base: '/Notebook/',

  
  // Serve the existing tsl folder as static files
  publicDir: 'public',
  outDir: 'dist',
  
  vite: {
    // Configure Vite for better development experience
    server: {
      host: true,
      port: 4321
    },
    // Handle existing static assets
    assetsInclude: ['**/*.svg', '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif']
  },
  
  // Configure routing
  output: 'static',
  
  // Build configuration
  build: {
    // Don't inline assets by default for better caching
    assetsPrefix: '/',
    format: 'directory'
  }
});
