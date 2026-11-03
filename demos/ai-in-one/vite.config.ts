import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'static-sample-only',
      resolveId: (id) => id === 'virtual:embedded-sample' ? '\0embedded-sample' : undefined,
      load: (id) => id === '\0embedded-sample' ? 'export default null' : undefined,
    },
  ],
  build: {
    sourcemap: false,
    rollupOptions: { input: { app: resolve('index.html'), report: resolve('report.html') } },
  },
})
