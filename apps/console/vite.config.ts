/**
 * Builds the console's browser code: `web/` in, `dist/` out. The Node server serves `dist/` by its manifest.
 *
 * In development (`pnpm dev`), Vite serves the page with hot reloading on :5173 and passes events, artifacts
 * and the health and version endpoints to the Node server on :5174. With ADMIN_URL set, it passes `/admin/` to an admin
 * service there too, as Traefik does in the cluster, so the page can sign in: start `factory admin` with ADMIN_ORIGIN
 * http://localhost:5173. The cluster's ingress has :8443.
 */
import prefresh from '@prefresh/vite';
import { defineConfig } from 'vite';

/**
 * Development only: Vite injects styles as <style> elements and Fast Refresh runs an inline script,
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

const SERVER = `http://localhost:${process.env.SERVER_PORT ?? 5174}`;

/** An admin service on the host, if one is running: the page finds none otherwise, and offers no sign-in. */
const ADMIN = process.env.ADMIN_URL;

export default defineConfig({
  root: 'web',
  plugins: [await prefresh()],
  // Preact's JSX, the automatic runtime that web/tsconfig.json checks: Fast Refresh's plugin otherwise assumes `h`.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  // The code is written to React's API and runs on Preact's (ADR 0007), in half the JavaScript. web/tsconfig.json
  // points the type checker the same way.
  resolve: {
    alias: [
      { find: /^react$/, replacement: 'preact/compat' },
      { find: /^react-dom\/client$/, replacement: 'preact/compat/client' },
    ],
  },
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
    port: 5173,
    strictPort: true,
    headers: { 'content-security-policy': DEVELOPMENT_POLICY },
    proxy: {
      ...Object.fromEntries(['/api', '/artifacts', '/health', '/version'].map((path) => [path, SERVER])),
      // The browser's Origin goes through as it is, which the service matches against its own ADMIN_ORIGIN.
      ...(ADMIN && { '/admin': ADMIN }),
    },
    // The design system's tokens and station live outside web/.
    fs: { allow: ['../../..'] },
  },
});
