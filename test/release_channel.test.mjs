import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { register } from 'node:module'

register('../scripts/lib/ts-resolve-hooks.mjs', import.meta.url)
const { configureApp } = await import('../kernel/src/app.ts')
const { checkForUpdates, fetchPinned } = await import('../kernel/src/update.ts')

test('darislides update channel accepts our signatures and rejects tampering and other publishers', async () => {
  const { publicKey: public_key, privateKey: private_key } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const { privateKey: other_key } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  configureApp({ appId: 'darislides', appName: 'darislides', manifestUrl: 'https://updates.example/manifest.json',
    publicKeyJwk: public_key.export({ format: 'jwk' }), syncHost: 'wss://sync.example' })
  const bytes = Buffer.from('the built darislides shell')
  const release = { app: 'darislides', version: '0.1.1',
    url: 'https://updates.example/0.1.1/darislides.bento.html', sha256: createHash('sha256').update(bytes).digest('hex') }
  function signRelease(payload, key = private_key) {
    const text = JSON.stringify(payload)
    return JSON.stringify({ payload: text, sig: sign('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }).toString('base64') })
  }
  const original_fetch = globalThis.fetch
  let response = signRelease(release)
  globalThis.fetch = async () => new Response(response)
  try {
    assert.equal((await checkForUpdates()).status, 'update')
    response = signRelease(release, other_key)
    assert.equal((await checkForUpdates()).status, 'error')
    response = signRelease({ ...release, app: 'bento-slides' })
    assert.equal((await checkForUpdates()).status, 'error')
    response = signRelease({ ...release, version: '0.0.0' })
    assert.equal((await checkForUpdates()).status, 'current')
    const envelope = JSON.parse(signRelease(release))
    envelope.payload += ' '
    response = JSON.stringify(envelope)
    assert.equal((await checkForUpdates()).status, 'error')
    response = bytes
    assert.ok(await fetchPinned(release.url, release.sha256))
    response = Buffer.from('tampered')
    assert.equal(await fetchPinned(release.url, release.sha256), null)
  } finally { globalThis.fetch = original_fetch }
})
