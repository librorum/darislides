import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCollabCredentials } from '../integration/collab_credentials.js'

test('hosted documents use our relay and valid Bento owner commitments', async () => {
  const credentials = await createCollabCredentials('wss://sync.slides.example')
  const owner = Buffer.from(credentials.owner, 'base64url')
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', owner)).toString('base64url')
  assert.equal(credentials.room, `wss://sync.slides.example/d/w${digest}`)
  assert.equal(Buffer.from(credentials.key, 'base64url').length, 32)
  const private_key = await crypto.subtle.importKey('pkcs8', Buffer.from(credentials.ownerPriv, 'base64url'),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const public_key = await crypto.subtle.importKey('raw', owner, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const text = new TextEncoder().encode('relay hello')
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, private_key, text)
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, public_key, signature, text))
  await assert.rejects(createCollabCredentials('https://sync.bento.page'), /slides_invalid_sync_host/)
})
