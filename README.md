# CraftLife Notebook

Interactive tutorials and projects for web technologies, GPU computing, and
creative coding.

## Getting Started

This is an [Astro](https://astro.build/) website that serves as a hub for
various interactive tutorials and projects.

### Prerequisites

- [Bun](https://bun.sh/) (JavaScript runtime and package manager)

### Development

1. Install dependencies:
   ```bash
   bun install
   ```

2. Start the development server:
   ```bash
   bun run dev
   ```

3. Open [http://localhost:4321](http://localhost:4321) in your browser.

### Project Structure

```
Notebook/
├── src/
│   ├── pages/          # Astro pages (routes)
│   └── layouts/        # Reusable layout components
├── public/             # Static assets
│   └── tsl/           # TSL Compute Shaders guide (static copy)
├── tsl/               # Original TSL project (with its own build system)
└── dist/              # Built site (after running 'bun run build')
```

### Adding New Projects

1. **For static projects**: Add them to the `public/` directory
2. **For Astro-powered content**: Create new pages in `src/pages/`
3. **For Markdown content**: Create `.md` or `.mdx` files in `src/pages/`

### Current Projects

- **TSL Compute Shaders**: Interactive guide to Three.js Shading Language and
  WebGPU compute shaders
  - Live version: `/tsl/`
  - Source: `tsl/` directory

### Building for Production

```bash
bun run build
```

The built site will be in the `dist/` directory.

### Technology Stack

- [Astro](https://astro.build/) - Static site generator
- [Bun](https://bun.sh/) - JavaScript runtime and package manager
- [Vite](https://vitejs.dev/) - Build tool (integrated with Astro)
- [MDX](https://mdxjs.com/) - Markdown with JSX support

## License

See [LICENSE](LICENSE) file for details.
