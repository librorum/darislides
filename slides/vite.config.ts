import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const base_config = JSON.parse(readFileSync(new URL('../config/darislides.json', import.meta.url), 'utf8'))
const release_path = process.env.DARISLIDES_RELEASE_CONFIG
const release_config = release_path ? JSON.parse(readFileSync(release_path, 'utf8')) : {}
if (process.env.DARISLIDES_RELEASE && !(release_config.public_key_jwk || base_config.public_key_jwk))
  throw new Error('A publisher public key is required for release builds')
const config = { ...base_config, ...release_config, version: pkg.version,
  sync_host: process.env.DARISLIDES_SYNC_HOST || release_config.sync_host || base_config.sync_host,
  // No fallback to Bento's signing key: unconfigured development builds reject updates.
  public_key_jwk: release_config.public_key_jwk ?? base_config.public_key_jwk ?? { kty: 'EC', crv: 'P-256', x: '', y: '' },
}

// base './' so builds open from file:// or any static host.
// SINGLEFILE=1 → everything (JS, CSS, assets) inlined into one HTML file:
// that file IS the Bento document format.
export default defineConfig({
  base: './',
  // The app version baked into every shipped shell — what update checks
  // compare against the release manifest. Single source: package.json.
  define: { __APP_VERSION__: JSON.stringify(config.version), __DARISLIDES_CONFIG__: JSON.stringify(config) },
  plugins: [...(process.env.SINGLEFILE ? [viteSingleFile()] : [])],
  // Dev-only: allow serving ../kernel (shared TS-source kernel) — without a
  // workspace root, vite's fs allow-list stops at the app dir. Build output
  // is unaffected (rollup has no such restriction).
  server: { fs: { allow: ['..'] } },
  build: {
    // Keep asset inlining aggressive; a Bento file must have zero external requests.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4096,
  },
})
