import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@hostelcode/shared': path.resolve(__dirname, '../../packages/shared/dist/index.js'),
        },
        dedupe: ['yjs', 'y-protocols'],
    },
    server: {
        port: 5173,
        host: true,
    },
});
