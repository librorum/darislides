// Run locally after an explicitly approved release; the private key stays outside Git.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'

const root_dir = fileURLToPath(new URL('../', import.meta.url))
const [bucket, manifest_path] = process.argv.slice(2)
if (!bucket || !manifest_path) throw new Error('Usage: node scripts/publish_r2.mjs <bucket> <manifest.json>')
const config_path = process.env.DARISLIDES_RELEASE_CONFIG
if (!config_path) throw new Error('DARISLIDES_RELEASE_CONFIG is required')
const config = JSON.parse(readFileSync(resolve(config_path), 'utf8'))
const pkg = JSON.parse(readFileSync(resolve(root_dir, 'package.json'), 'utf8'))
const envelope = JSON.parse(readFileSync(manifest_path, 'utf8'))
const release = JSON.parse(envelope.payload)
const shell_path = resolve(root_dir, 'slides/dist-single/Bento_Slides.bento.html')
const shell = readFileSync(shell_path)
const public_key = createPublicKey({ key: config.public_key_jwk, format: 'jwk' })
if (!verify('sha256', Buffer.from(envelope.payload), { key: public_key, dsaEncoding: 'ieee-p1363' }, Buffer.from(envelope.sig, 'base64')))
  throw new Error('Invalid manifest signature')
if (release.app !== 'darislides' || release.version !== pkg.version
  || release.sha256 !== createHash('sha256').update(shell).digest('hex')) throw new Error('Manifest does not match this build')
const manifest_url = new URL(config.manifest_url)
const shell_url = new URL(release.url)
const shell_key = `releases/slides/${release.version}/darislides.bento.html`
if (shell_url.origin !== manifest_url.origin || shell_url.pathname !== `/${shell_key}`)
  throw new Error('Release must point to an immutable versioned object on our update origin')
function uploadRelease(key, file_path, content_type, cache_control) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', 'r2', 'object', 'put', `${bucket}/${key}`,
    '--file', file_path, '--content-type', content_type, '--cache-control', cache_control, '--remote'],
  { cwd: root_dir, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`R2 upload failed: ${key}`)
}
// The manifest changes last: clients must never see an unavailable shell.
uploadRelease(shell_key, shell_path, 'text/html; charset=utf-8', 'public, max-age=31536000, immutable')
uploadRelease(manifest_url.pathname.slice(1), resolve(manifest_path), 'application/json', 'public, max-age=60')
