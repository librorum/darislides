// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// 재생 화면. 편집기 셸(main.ts)과 다리챗 보기 전용 셸(player_main.ts)이 같이 쓴다.
// 이 파일은 편집기 모듈을 끌어오지 않아야 보기 전용 셸이 가벼워진다.

import { appConfig } from '../../kernel/src/app.ts'
import { darichatHostOrigin, sendThumbnail } from './darichat_bridge'
import { serializeAuto, downloadFile, suggestedFileName } from './save'
import { t } from './i18n'
import type { BentoDoc } from './model'
import { injectFonts } from './fonts'
import { startPresentation, type PresentSession } from './present'
import { armPicker } from './darichat_pick'

/**
 * Read-only files are PLAYER files: they open straight into the show and
 * never expose the editor. Leaving the presentation lands on a minimal card.
 */
export function playerMode(doc: BentoDoc, editable = false) {
  document.title = `${doc.title} — ${appConfig().appName}`
  if (doc.fonts?.length) injectFonts(doc)
  document.getElementById('bento-splash')?.remove()
  const card = document.createElement('div')
  card.className = 'ed-player'
  card.innerHTML =
    `<div class="ed-playercard"><h1>${doc.title.replace(/</g, '&lt;')}</h1>` +
    `<p>${t('This is a presentation package — view and present only.')}</p>` +
    `<button class="ed-playgo">▶&nbsp; ${t('Present')}</button>` +
    `<button class="ed-playcopy">⤓&nbsp; ${t('Save a copy')}</button></div>`
  document.body.appendChild(card)
  if (editable && !darichatHostOrigin()) {
    const edit_button = document.createElement('button')
    edit_button.textContent = t('Edit')
    edit_button.addEventListener('click', () => {
      location.hash = '#edit'
      location.reload()
    })
    card.querySelector('.ed-playercard')!.appendChild(edit_button)
  }
  // darichat hosts the viewer toolbar: it steps the show and shows the page
  const parent_origin = darichatHostOrigin()
  const sendHost = (data: Record<string, unknown>) => {
    if (parent_origin) window.parent.postMessage({ channel: 'darislides', ...data }, parent_origin)
  }
  let show: PresentSession | null = null
  const start = () => {
    card.style.display = 'none'
    show = startPresentation(doc, 0, () => {
      show = null
      card.style.display = ''
    }, { onSlide: (page, total, index) => sendHost({ type: 'page', page, total, slide_id: doc.slides[index]?.id }) })
  }
  card.querySelector('.ed-playgo')!.addEventListener('click', start)
  card.querySelector('.ed-playcopy')!.addEventListener('click', () => {
    void serializeAuto(doc).then((html) => downloadFile(html, suggestedFileName(doc)))
  })
  ;(window as any).bento = { format: doc.format, doc, readonly: true }
  start()
  if (!parent_origin) return
  const setPick = armPicker(doc, sendHost)
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== parent_origin
      || event.data?.channel !== 'darislides') return
    const { type } = event.data
    if (type === 'pick_mode') return setPick(event.data.on === true)
    if (type === 'thumbnail') return void sendThumbnail(doc, event.data.request_id, sendHost)
    if (type !== 'next' && type !== 'prev' && type !== 'goto') return
    if (type === 'goto') {
      const index = doc.slides.findIndex((slide) => slide.id === event.data.slide_id)
      if (!show) start()
      if (index >= 0) show!.goTo(index)
      return
    }
    if (!show) return start()
    if (type === 'next') show.next()
    else show.prev()
  })
  sendHost({ type: 'ready' })
}

