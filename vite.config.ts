import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command, mode }) => ({
  plugins: [react()],
  base: './',
  server: { port: 5173 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    minify: 'esbuild',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id) return;
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom')) return 'vendor_react';
            if (id.includes('sql.js')) return 'vendor_sqljs';
            if (id.includes('webtorrent')) return 'vendor_webtorrent';
            return 'vendor';
          }
        }
      }
    }
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'sql.js', 'webtorrent'],
    esbuildOptions: { target: 'es2020' }
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode)
  },
  commonjsOptions: {
    transformMixedEsModules: true
  }
}))