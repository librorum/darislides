// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// 다리챗 보기 전용 셸의 시작점. 편집기·협업 모듈 없이 재생 화면과 PDF 인쇄 모드만 띄운다.
// 편집은 다리챗이 편집기 셸(main.ts)을 따로 받아 띄운다.

import './styles.css'
import { printMode } from './darichat_bridge'
import { registerDarislidesLocale } from './darislides_locale'
import { configureApp } from '../../kernel/src/app.ts'
import { startTheme } from '../../kernel/src/theme.ts'
import { capturePristine, readEmbeddedDoc } from './save'
import { applyDirection } from './i18n'
import { parseDoc } from './model'
import { guardOpenedDoc } from './restoregate'
import { resolveThemeRefs } from './palette'
import { playerMode } from './player'

declare const __DARISLIDES_CONFIG__: {
  manifest_url: string; sync_host: string;
  public_key_jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
}
configureApp({
  appId: 'darislides',
  appName: 'darislides',
  manifestUrl: __DARISLIDES_CONFIG__.manifest_url,
  syncHost: __DARISLIDES_CONFIG__.sync_host,
  publicKeyJwk: __DARISLIDES_CONFIG__.public_key_jwk,
})
registerDarislidesLocale()
// 재생 화면의 '사본 저장'이 이 복사본으로 파일을 만든다
capturePristine()
startTheme()
applyDirection()

const embedded = readEmbeddedDoc()
const doc = embedded ? parseDoc(embedded) : null
if (!doc) {
  document.getElementById('bento-splash')?.remove()
  console.error('[darislides] player: no document')
} else {
  const dropped = guardOpenedDoc(doc)
  if (dropped.length) console.info('[bento] opened file: neutralised', dropped)
  resolveThemeRefs(doc)
  if (document.documentElement.dataset.darislidesMode === 'print') void printMode(doc)
  else playerMode(doc)
}
