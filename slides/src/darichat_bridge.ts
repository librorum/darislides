import type { Store } from './store'
import type { SyncSession } from './sync/session'
import type { LoadReport } from './compactload'
import type { BentoDoc } from './model'
import { rasterizeSlide } from './editor/exportimages'
import { exportableSlides } from './exportimages'
import { injectFonts } from './fonts'

declare const __DARISLIDES_CONFIG__: { parent_origins: string[] }

export function darichatHostOrigin(): string | null {
  if (window.parent === window) return null
  try {
    // https 부모의 srcdoc 은 referrer 가 비므로 물려받은 window.origin 을 쓴다
    const parent_origin = new URL(document.referrer || window.origin).origin
    return __DARISLIDES_CONFIG__.parent_origins.includes(parent_origin) ? parent_origin : null
  } catch { return null }
}

// 다리챗 슬라이드 목록 미리보기 — 첫 장을 가로 480px JPEG 로 그려 부모에 돌려준다
const thumbnail_width = 480

async function thumbnailBlob(doc: BentoDoc): Promise<Blob> {
  const slide = exportableSlides(doc)[0] ?? doc.slides[0]
  if (!slide) throw new Error('slides_slide_not_found')
  const bitmap = await createImageBitmap(await rasterizeSlide(doc, slide, 'jpeg', 1))
  const canvas = document.createElement('canvas')
  canvas.width = thumbnail_width
  canvas.height = Math.round(thumbnail_width * bitmap.height / bitmap.width)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode'))), 'image/jpeg', 0.8)
  })
}

export async function sendThumbnail(doc: BentoDoc, request_id: string,
  send: (data: Record<string, unknown>) => void): Promise<void> {
  try {
    send({ type: 'thumbnail', request_id, blob: await thumbnailBlob(doc) })
  } catch (error) {
    send({ type: 'error', request_id, message: error instanceof Error ? error.message : 'slides_thumbnail_failed' })
  }
}

// 다리챗 PDF 내보내기 — 숨은 iframe 에서 편집기·재생 없이, 부모가 달라는 쪽을 JPEG 로 그려 돌려준다
const page_image_scale = 2

export function pagesMode(doc: BentoDoc): void {
  document.title = doc.title
  // 로더는 이 값으로 앱이 떴는지 본다. 없으면 부팅을 되풀이한다
  ;(window as any).bento = { format: doc.format, doc, readonly: true }
  if (doc.fonts?.length) injectFonts(doc)
  document.getElementById('bento-splash')?.remove()
  const parent_origin = darichatHostOrigin()!
  const pages = exportableSlides(doc)
  const send = (data: Record<string, unknown>) => window.parent.postMessage({ channel: 'darislides', ...data }, parent_origin)
  window.addEventListener('message', async (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== parent_origin
      || event.data?.channel !== 'darislides' || event.data.type !== 'page_image') return
    const { request_id, index } = event.data
    try {
      send({ type: 'page_image', request_id, blob: await rasterizeSlide(doc, pages[index], 'jpeg', page_image_scale) })
    } catch (error) {
      send({ type: 'error', request_id, message: error instanceof Error ? error.message : 'slides_page_image_failed' })
    }
  })
  send({ type: 'ready', total: pages.length, width: doc.size.width, height: doc.size.height, scale: page_image_scale })
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
      if (type === 'thumbnail') {
        void sendThumbnail(snapshotSlides(), request_id, (data) => sendSlides(data.type as string, data))
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
