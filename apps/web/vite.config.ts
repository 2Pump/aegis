import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Nado is reached through same-origin paths so the app works whether or not Nado sends CORS headers.
// Production (Vercel) mirrors these in vercel.json.
const nadoProxy = {
  '/nado/gateway': {
    target: 'https://api.prod.nado.xyz',
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/nado\/gateway/, '/gateway/v1'),
  },
  '/nado/archive': {
    target: 'https://api.prod.nado.xyz',
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/nado\/archive/, '/archive/v1'),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: nadoProxy },
  preview: { port: 4173, proxy: nadoProxy },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          chain: ['viem', 'wagmi', '@tanstack/react-query'],
        },
      },
    },
  },
});
