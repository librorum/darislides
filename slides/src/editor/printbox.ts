// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import { renderSlide } from '../render'
import { inLinearFlow, type BentoDoc } from '../model'

/**
 * The print container: every linear slide as one exact page, width normalised
 * to 1600 and height following the deck's aspect. Anything outside the linear
 * flow stays off the paper: a state is reachable only through interaction, and
 * a hidden slide is material the audience was not meant to be handed.
 */
export function buildPrintBox(doc: BentoDoc): HTMLElement {
  const box = document.createElement('div')
  box.id = 'bento-print'
  const pageH = Math.round((1600 * doc.size.height) / doc.size.width)
  const pageCss = document.createElement('style')
  pageCss.textContent = `@page { size: 1600px ${pageH}px; margin: 0; } #bento-print .bp-page { height: ${pageH}px; }`
  box.appendChild(pageCss)
  const scale = 1600 / doc.size.width
  for (const slide of doc.slides) {
    if (!inLinearFlow(slide)) continue
    const page = document.createElement('div')
    page.className = 'bp-page'
    const surface = renderSlide(slide, doc, { svgAsImage: true, hidePlaceholders: true })
    surface.style.transformOrigin = '0 0'
    if (scale !== 1) surface.style.transform = `scale(${scale})`
    page.appendChild(surface)
    box.appendChild(page)
  }
  return box
}
