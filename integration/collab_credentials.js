// Bento v2 capability envelope, minted once before a hosted document is opened.
// This prevents two first-time editors from creating separate collaboration rooms.
function encodeBase64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function createCollabCredentials(sync_host) {
  const url = new URL(sync_host)
  if (!['wss:', 'ws:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash)
    throw new Error('slides_invalid_sync_host')
  const key_pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const public_bytes = await crypto.subtle.exportKey('raw', key_pair.publicKey)
  const commitment = await crypto.subtle.digest('SHA-256', public_bytes)
  const room_key = crypto.getRandomValues(new Uint8Array(32))
  return { room: `${url.origin.replace(/^http/, 'ws')}/d/w${encodeBase64Url(commitment)}`,
    key: encodeBase64Url(room_key), on: true, v: 2,
    owner: encodeBase64Url(public_bytes),
    ownerPriv: encodeBase64Url(await crypto.subtle.exportKey('pkcs8', key_pair.privateKey)), role: 'writer' }
}
