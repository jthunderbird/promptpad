import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const single = !!process.env.SINGLE;
export default defineConfig({
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  plugins: single ? [viteSingleFile()] : [],
});
