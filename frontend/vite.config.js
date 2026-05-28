import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// CloudFront(d300v14l8u0wx7.cloudfront.net) 의 Origin Path 가 `/frontend` 이고
// DefaultRoot=index.html 이라 브라우저에서 보는 base 는 항상 `/`.
// 즉 `/assets/main-XXX.js` 가 CloudFront 에서 `s3://bucket/frontend/assets/main-XXX.js`
// 로 매핑됨. 따라서 프로덕션 base 도 `/` 가 맞음.
// (이전에 base='/Frontend/' 였지만 OriginPath 와 충돌 → 사이트 깨짐. 2026-05-14 수정)
//
// 백엔드 (FastAPI · uvicorn :8000) dev proxy:
//   /api/*  → localhost:8000  (sessions, patients, feedback, ...)
//   /ws/*   → localhost:8000  (WebSocket emr-updates)
// production 에선 CloudFront 의 별도 behavior 또는 직접 도메인 (api.rare-link.kr) 으로 대체.

// https://vitejs.dev/config/
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true, // 5173 점유 시 fallback 대신 에러 — SMART Launcher URL 일관성 유지
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Multi-entry: SMART on FHIR launch/callback HTML 페이지를 별도 entry로 빌드.
    // index.html은 React SPA, launch.html/app.html은 fhirclient 단독 페이지.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        launch: resolve(__dirname, 'launch.html'),
        app: resolve(__dirname, 'app.html'),
      },
    },
  },
});
