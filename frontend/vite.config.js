import { fileURLToPath, URL } from 'node:url'
import { loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      // three's core bundle alone is ~737 kB minified and is not further
      // splittable, so the warning threshold sits just above it rather than
      // hiding a real regression in the app chunks.
      chunkSizeWarningLimit: 800,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              // The README mandates MapLibre GL, so this is the map vendor.
              {
                name: 'maplibre',
                test: /node_modules[\\/](maplibre-gl|react-map-gl)[\\/]/,
              },
              {
                name: 'motion',
                test: /node_modules[\\/](motion|framer-motion|@motionone|motion-dom|motion-utils)[\\/]/,
              },
              {
                name: 'react-vendor',
                test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
              },
            ],
          },
        },
      },
    },
    server: {
      // Must match CORS_ORIGINS in the backend's .env, which lists
      // http://localhost:5173 and http://127.0.0.1:5173.
      port: 5173,
      proxy: {
        /*
          NO REWRITE HERE, deliberately.

          The integrated backend (origin/sync-main-with-integration) mounts every
          router under an explicit /api prefix - database/main.py calls
          app.include_router(routes_router, prefix="/api"), and the contract in
          tests_docs/api_contract.yaml declares base_path: /api. So the browser's
          /api/routes has to arrive at the backend as /api/routes.

          An earlier version of this file stripped the prefix. That was correct
          against the retired backend/ app (Member 1), which mounted routers with
          no prefix at all. Against the current app the same rewrite turns every
          request into a 404.

          The proxy exists only to dodge CORS during development. Setting
          VITE_API_URL makes the browser call the API cross-origin instead,
          which also works because the backend allows CORS from :5173.
        */
        '/api': {
          target: env.VITE_API_URL || 'http://localhost:8000',
          changeOrigin: true,
          ws: true, // the live bus feed is a WebSocket at /api/ws/buses
        },
      },
    },
  }
})
