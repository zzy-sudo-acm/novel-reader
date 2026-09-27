import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/novel-reader/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: '小说阅读器',
        short_name: '阅读器',
        description: '纯本地小说阅读器，支持离线阅读',
        lang: 'zh-CN',
        start_url: '/novel-reader/',
        scope: '/novel-reader/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/novel-reader/index.html',
        globPatterns: ['**/*.{js,css,html,png,webmanifest,svg}'],
      },
    }),
  ],
});
