import { defineConfig } from 'vite';

// During development the Vite site (5173) forwards API and sign-in requests to the server (3000).
const forward = {
  '/api': 'http://localhost:3000',
  '/auth': 'http://localhost:3000',
  '/uploads': 'http://localhost:3000',
};

export default defineConfig({
  base: '/',
  server: { host: '0.0.0.0', port: 5173, strictPort: true, proxy: forward },
  preview: { host: '0.0.0.0', port: 4173, strictPort: true, proxy: forward },
  build: { rollupOptions: { input: { main: 'index.html', app: 'app.html' } } },
});
