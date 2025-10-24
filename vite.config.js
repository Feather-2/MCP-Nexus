import { defineConfig } from 'vite'

export default defineConfig({
  root: './gui',
  build: {
    outDir: '../dist-gui',
    emptyOutDir: true
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:19233',
        changeOrigin: true
      },
      '/health': {
        target: 'http://localhost:19233',
        changeOrigin: true
      }
    }
  }
})