/**
 * Builds the console's browser code: `web/` in, `dist/` out. The Node server serves `dist/` by its manifest.
 *
 * In development (`pnpm dev`), Vite serves the page with hot reloading on :8080 and passes events, artifacts
 * and the health and version endpoints to the Node server on :8081.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Development only: Vite injects styles as <style> elements and React's Fast Refresh runs an inline script,
 * which the production policy refuses. The tests run against the production build and its policy.
 */
const DEVELOPMENT_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'self' ws:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SERVER = `http://localhost:${process.env.SERVER_PORT ?? 8081}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // The commit the build was made from, for the footer: the image passes it in; development says so.
  define: { __BUILD__: JSON.stringify(process.env.GIT_COMMIT ?? 'dev') },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    manifest: true,
    // Every asset is a file of its own, never inlined as a data: URL, which the policy would refuse.
    assetsInlineLimit: 0,
    target: 'es2024',
  },
  server: {
    port: 8080,
    strictPort: true,
    headers: { 'content-security-policy': DEVELOPMENT_POLICY },
    proxy: Object.fromEntries(['/api', '/artifacts', '/health', '/version'].map((path) => [path, SERVER])),
    // The design system's tokens and station live outside web/.
    fs: { allow: ['../../..'] },
  },
});
