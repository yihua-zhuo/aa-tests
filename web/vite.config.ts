import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  // WSL 的 /mnt/c (9p) 上提交依赖优化缓存会 EACCES，改用本地临时目录
  cacheDir: process.env.VITE_CACHE_DIR ?? join(tmpdir(), 'clay-dashboard-vite'),
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('recharts') || id.includes('d3-') || id.includes('victory-vendor')) {
            return 'charts';
          }
          if (id.includes('react-router') || id.includes('/react-dom/') || id.includes('/react/')) {
            return 'react-vendor';
          }
          return undefined;
        },
      },
    },
  },
});
