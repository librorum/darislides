import type { Store } from './store'
import type { SyncSession } from './sync/session'
import type { LoadReport } from './compactload'
import type { BentoDoc } from './model'

declare const __DARISLIDES_CONFIG__: { parent_origins: string[] }

export function darichatHostOrigin(): string | null {
  if (window.parent === window) return null
  try {
    // https 부모의 srcdoc 은 referrer 가 비므로 물려받은 window.origin 을 쓴다
    const parent_origin = new URL(document.referrer || window.origin).origin
    return __DARISLIDES_CONFIG__.parent_origins.includes(parent_origin) ? parent_origin : null
  } catch { return null }
}

// This bridge is dormant in standalone files. Credentials stay in the parent.
export function connectDarichat(store: Store, session: SyncSession,
  loadDoc: (json: string) => LoadReport | false): void {
  const parent_origin = darichatHostOrigin()
  if (parent_origin == null) return
  const target_origin: string = parent_origin
  let loading = false
  function sendSlides(type: string, options: Record<string, unknown> = {}) {
    window.parent.postMessage({ channel: 'darislides', type, ...options }, target_origin)
  }
  function snapshotSlides(): BentoDoc {
    session.flush()
    session.stampInto(store.doc)
    return structuredClone(store.doc)
  }
  store.on('doc', () => {
    if (!loading) sendSlides('changed')
  })
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== parent_origin
      || event.data?.channel !== 'darislides') return
    const { type, request_id, doc } = event.data
    try {
      if (type === 'read') {
        sendSlides('document', { request_id, doc: snapshotSlides() })
        return
      }
      if (type !== 'load') return
      if (doc?.docId !== store.doc.docId) throw new Error('slides_identity_changed')
      loading = true
      const report = loadDoc(JSON.stringify(doc))
      if (!report) throw new Error('slides_invalid_document')
      sendSlides('loaded', { request_id, report })
    } catch (error) {
      sendSlides('error', { request_id, message: error instanceof Error ? error.message : 'slides_invalid_document' })
    } finally {
      loading = false
    }
  })
  sendSlides('ready')
}
