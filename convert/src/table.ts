// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// a:tbl → the body of a bento `table` element (columns / rows / header /
// style). The frame, id and z-order are the orchestrator's (pptx.ts).
//
// The two formats split formatting differently. A PowerPoint table styles
// every cell through a TABLE STYLE (ppt/tableStyles.xml, or a built-in one
// referenced by GUID only) overlaid by each cell's own a:tcPr, and every run
// carries its own size/colour/face. bento keeps one table-wide `style` and
// per-cell overrides (bg, color, bold, align). So:
//
//   - Region fills (wholeTbl, band1H) are BAKED into each body cell's `bg`,
//     because bento has no body fill and its zebra stripes the OTHER parity
//     (renderTableHtml stripes bodyIndex 1, 3…; band1H paints 0, 2…). The
//     header row's fill and ink go to style.headerBg/headerColor.
//   - Size and face flatten to the DOMINANT run of the whole table (by
//     character count, the text.ts rule), reported when runs disagree.
//   - One border colour/width for every cell side; reported when the source
//     varies it.
//   - Merged cells (gridSpan/rowSpan/hMerge/vMerge) have no model field: the
//     origin keeps the content, continuation cells stay empty, reported.
//
// Cell html is the same reduced inline subset text.ts emits (b/i/u/s/br),
// plus an <a href> for http(s) hyperlinks — render.ts's sanitizer keeps an
// anchor's href only when it is a web URL, and so does this module.

import { NS, kid, kids, attr, intAttr, textOf, parseXml, type XElem } from './xml.ts'
import { resolveColor, resolveFillRef } from './theme.ts'
import type { Rel } from './media.ts'
import {
  EMU_PER_PX, METRIC_SUBSTITUTES, safeFace, cssFace,
  type InheritCtx, type OutTable, type OutTableCell,
} from './types.ts'

export interface TableDeps {
  /** rels of the part holding the table — run hyperlinks resolve here */
  rels: Map<string, Rel>
  /** ppt/tableStyles.xml root, when the package has one */
  styles?: XElem
  where: string
}

export type TableBody = Pick<OutTable, 'columns' | 'rows' | 'header' | 'style'>

const px = (emu: number): number => Math.round((emu / EMU_PER_PX) * 100) / 100
const r2 = (v: number): number => Math.round(v * 100) / 100
const on = (v: string | undefined): boolean => v === '1' || v === 'true' || v === 'on'
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * "Medium Style 2 – Accent 1", PowerPoint's (and python-pptx's) default table
 * style. Built-in styles are referenced by GUID alone and a package may carry
 * no definition (an empty tblStyleLst is common), so the one everybody gets by
 * default is spelled out here in the file format's own terms.
 */
const BUILTIN_STYLES: Record<string, string> = {
  '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}':
    `<a:tblStyle xmlns:a="${NS.a}" styleId="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}">` +
    '<a:wholeTbl><a:tcTxStyle><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr>' +
    '<a:insideH><a:ln w="12700"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:insideH>' +
    '</a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="20000"/></a:schemeClr>' +
    '</a:solidFill></a:fill></a:tcStyle></a:wholeTbl>' +
    '<a:band1H><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="40000"/>' +
    '</a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1H>' +
    '<a:firstRow><a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr/>' +
    '<a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:firstRow>' +
    '</a:tblStyle>',
}

function findStyle(id: string, styles: XElem | undefined): XElem | undefined {
  if (styles) for (const s of kids(styles, NS.a, 'tblStyle')) if (attr(s, 'styleId') === id) return s
  const builtin = BUILTIN_STYLES[id]
  return builtin ? parseXml(builtin) : undefined
}

/** A fill as css: 'transparent' for an explicit noFill, undefined when the
 *  element says nothing (or nothing resolvable). */
function fillCss(holder: XElem | undefined, ctx: InheritCtx, onLossy: () => void): string | undefined {
  if (!holder) return undefined
  if (kid(holder, NS.a, 'noFill')) return 'transparent'
  const solid = kid(holder, NS.a, 'solidFill')
  if (solid) return resolveColor(solid, ctx.theme)?.css
  const grad = kid(holder, NS.a, 'gradFill')
  if (grad) {
    onLossy()
    const gs = kid(grad, NS.a, 'gsLst')
    const first = gs ? kids(gs, NS.a, 'gs')[0] : undefined
    return first ? resolveColor(first, ctx.theme)?.css : undefined
  }
  if (kid(holder, NS.a, 'blipFill') || kid(holder, NS.a, 'pattFill')) onLossy()
  return undefined
}

/** One table-style region (wholeTbl, firstRow, band1H…): fill + ink + bold. */
interface Region { fill?: string; ink?: string; bold?: boolean; border?: Border }
interface Border { color: string; width: number }

function lineOf(ln: XElem | undefined, ctx: InheritCtx): Border | 'none' | undefined {
  if (!ln) return undefined
  if (kid(ln, NS.a, 'noFill')) return 'none'
  const c = resolveColor(kid(ln, NS.a, 'solidFill'), ctx.theme)
  return c ? { color: c.css, width: r2(intAttr(ln, 'w', 12700) / EMU_PER_PX) } : undefined
}

function regionOf(style: XElem | undefined, name: string, ctx: InheritCtx, onLossy: () => void): Region | undefined {
  const el = style && kid(style, NS.a, name)
  if (!el) return undefined
  const out: Region = {}
  const tx = kid(el, NS.a, 'tcTxStyle')
  if (tx) {
    const c = resolveColor(tx, ctx.theme)
    if (c) out.ink = c.css
    if (attr(tx, 'b') !== undefined) out.bold = on(attr(tx, 'b'))
  }
  const tcStyle = kid(el, NS.a, 'tcStyle')
  if (tcStyle) {
    const fillRef = kid(tcStyle, NS.a, 'fillRef')
    if (fillRef) {
      const ph = resolveColor(fillRef, ctx.theme)
      const got = resolveFillRef(intAttr(fillRef, 'idx'), ph?.css ?? '#FFFFFF', ctx.theme)
      if (got?.kind === 'solid') out.fill = got.color.css
      else if (got?.kind === 'none') out.fill = 'transparent'
      else onLossy()
    } else {
      const f = fillCss(kid(tcStyle, NS.a, 'fill'), ctx, onLossy)
      if (f) out.fill = f
    }
    const bdr = kid(tcStyle, NS.a, 'tcBdr')
    if (bdr) {
      for (const side of ['insideH', 'insideV', 'top', 'bottom', 'left', 'right']) {
        const sideEl = kid(bdr, NS.a, side)
        const b = sideEl ? lineOf(kid(sideEl, NS.a, 'ln'), ctx) : undefined
        if (b && b !== 'none') { out.border = b; break }
      }
    }
  }
  return out
}

/** Font stack for a run face, the text.ts / pptx.ts convention. */
function stackOf(face: string, ctx: InheritCtx): string | undefined {
  const safe = safeFace(face)
  if (!safe) {
    ctx.report.add('dropped', 'font-name-unsafe', 'font',
      'a typeface name contained characters that are not safe in CSS — the text uses a default face')
    return undefined
  }
  const sub = METRIC_SUBSTITUTES[safe]
  if (sub) {
    ctx.report.add('approximated', 'font-substituted', `font "${safe}"`,
      `'${safe}' is not embedded; emitted as a metric-compatible stack with '${sub}'`)
    return `${cssFace(safe)}, ${cssFace(sub)}, sans-serif`
  }
  return `${cssFace(safe)}, sans-serif`
}

/**
 * The table body, or undefined when the a:tbl has no grid or no rows — the
 * caller then keeps the placeholder box and reports it.
 */
export function tableFrom(tbl: XElem, ctx: InheritCtx, deps: TableDeps): TableBody | undefined {
  const grid = kid(tbl, NS.a, 'tblGrid')
  const cols = grid ? kids(grid, NS.a, 'gridCol') : []
  const trs = kids(tbl, NS.a, 'tr')
  if (cols.length === 0 || trs.length === 0) return undefined
  const { report } = ctx
  const where = deps.where

  const once = new Set<string>()
  const note = (verdict: 'approximated' | 'dropped', code: string, detail: string): void => {
    if (once.has(code)) return
    once.add(code)
    report.add(verdict, code, where, detail)
  }
  const lossyFill = (): void => note('approximated', 'table-fill-approximated',
    'a gradient/picture/pattern cell fill has no bento counterpart — flattened to its first colour or dropped')

  // ---- the table style: tblPr flags + the referenced style's regions
  const tblPr = kid(tbl, NS.a, 'tblPr')
  const header = tblPr !== undefined && on(attr(tblPr, 'firstRow'))
  const bandRow = tblPr !== undefined && on(attr(tblPr, 'bandRow'))
  const idEl = tblPr && kid(tblPr, NS.a, 'tableStyleId')
  const styleId = idEl ? textOf(idEl).trim() : ''
  const styleEl = styleId ? findStyle(styleId, deps.styles) : undefined
  if (styleId && !styleEl) {
    note('approximated', 'table-style-unresolved',
      `table style ${styleId.slice(0, 40)} is neither in the package nor built in — only the cells' own formatting is carried`)
  }
  if (styleEl && tblPr && ['firstCol', 'lastCol', 'lastRow', 'bandCol'].some((f) => on(attr(tblPr, f)))) {
    note('approximated', 'table-style-approximated',
      'first/last column, last row and column banding of the table style have no bento counterpart — not painted')
  }
  const whole = regionOf(styleEl, 'wholeTbl', ctx, lossyFill)
  const first = header ? regionOf(styleEl, 'firstRow', ctx, lossyFill) : undefined
  const band = bandRow ? regionOf(styleEl, 'band1H', ctx, lossyFill) : undefined

  const baseInk = whole?.ink ?? ctx.theme.scheme['tx1'] ?? '#000000'
  const headerInk = first?.ink ?? baseInk
  const headerBg = first?.fill ?? whole?.fill ?? 'transparent'

  // ---- cells
  const sizes = new Map<number, number>() // pt → chars
  const faces = new Map<string, number>()
  let mergedSeen = false
  let valignSeen = false
  const borders = new Map<string, number>() // 'color|width' or 'none' → sides
  let pad: { x: number; y: number } | undefined

  const rows: OutTable['rows'] = trs.map((tr, r) => {
    const isHeader = header && r === 0
    const bodyIndex = header ? r - 1 : r
    const tcs = kids(tr, NS.a, 'tc')
    const cells: OutTableCell[] = []
    for (let c = 0; c < cols.length; c++) {
      const tc = tcs[c]
      if (!tc) { cells.push({ html: '' }); continue }
      const cell: OutTableCell = { html: '' }
      const continuation = on(attr(tc, 'hMerge')) || on(attr(tc, 'vMerge'))
      if (continuation || intAttr(tc, 'gridSpan', 1) > 1 || intAttr(tc, 'rowSpan', 1) > 1) mergedSeen = true

      // fill: own tcPr → band → wholeTbl (header row: style.headerBg)
      const tcPr = kid(tc, NS.a, 'tcPr')
      const own = fillCss(tcPr, ctx, lossyFill)
      const regionFill = isHeader ? undefined
        : (band && bodyIndex % 2 === 0 ? band.fill : undefined) ?? whole?.fill
      const bg = own ?? regionFill
      if (bg && bg !== (isHeader ? headerBg : 'transparent')) cell.bg = bg

      if (tcPr) {
        pad ??= { x: px(intAttr(tcPr, 'marL', 91440)), y: px(intAttr(tcPr, 'marT', 45720)) }
        const anchor = attr(tcPr, 'anchor')
        if (anchor !== 'ctr') valignSeen = true
        for (const side of ['lnL', 'lnR', 'lnT', 'lnB']) {
          const b = lineOf(kid(tcPr, NS.a, side), ctx)
          if (!b) continue
          const key = b === 'none' ? 'none' : `${b.color}|${b.width}`
          borders.set(key, (borders.get(key) ?? 0) + 1)
        }
      } else valignSeen = true

      if (!continuation) Object.assign(cell, cellText(tc, isHeader))
      cells.push(cell)
    }
    if (tcs.length > cols.length) {
      note('dropped', 'table-cells-dropped', 'a row has more cells than the grid has columns — the extra cells are dropped')
    }
    return { cells }
  })

  function cellText(tc: XElem, isHeader: boolean): Partial<OutTableCell> {
    const txBody = kid(tc, NS.a, 'txBody')
    if (!txBody) return {}
    const regionInk = isHeader ? headerInk : baseInk
    const regionBold = isHeader ? (first?.bold ?? true) : (whole?.bold ?? false)
    interface Run { html: string; chars: number; bold: boolean; ink?: string }
    const paras: Array<{ runs: Run[]; chars: number; algn?: string }> = []
    for (const p of kids(txBody, NS.a, 'p')) {
      const pPr = kid(p, NS.a, 'pPr')
      const runs: Run[] = []
      let chars = 0
      for (const k of kids(p, NS.a)) {
        if (k.local === 'br') { runs.push({ html: '<br>', chars: 0, bold: false }); continue }
        if (k.local !== 'r' && k.local !== 'fld') continue
        const t = kid(k, NS.a, 't')
        const text = t ? textOf(t) : ''
        if (!text) continue
        const rPr = kid(k, NS.a, 'rPr')
        const sz = rPr ? intAttr(rPr, 'sz', 0) : 0
        const sizePt = sz > 0 ? sz / 100 : 18
        sizes.set(sizePt, (sizes.get(sizePt) ?? 0) + text.length)
        const latin = rPr && kid(rPr, NS.a, 'latin')
        const face = latin ? attr(latin, 'typeface') : undefined
        if (face) {
          const fam = face === '+mj-lt' ? ctx.theme.majorFont : face === '+mn-lt' ? ctx.theme.minorFont : face
          faces.set(fam, (faces.get(fam) ?? 0) + text.length)
        }
        const b = rPr ? attr(rPr, 'b') : undefined
        const ownInk = rPr ? kid(rPr, NS.a, 'solidFill') : undefined
        const ink = ownInk ? resolveColor(ownInk, ctx.theme)?.css : undefined
        let html = esc(text)
        if (rPr && attr(rPr, 'strike') !== undefined && attr(rPr, 'strike') !== 'noStrike') html = `<s>${html}</s>`
        if (rPr && attr(rPr, 'u') !== undefined && attr(rPr, 'u') !== 'none') html = `<u>${html}</u>`
        if (rPr && on(attr(rPr, 'i'))) html = `<i>${html}</i>`
        const link = rPr && kid(rPr, NS.a, 'hlinkClick')
        if (link) {
          const rel = deps.rels.get(rIdOf(link) ?? '')
          const href = rel && rel.mode === 'External' ? rel.target : ''
          if (/^https?:\/\//i.test(href) && !/[\s"<>]/.test(href)) html = `<a href="${href.replace(/&/g, '&amp;')}">${html}</a>`
          else note('dropped', 'table-link-dropped', 'a cell hyperlink that is not an http(s) URL is dropped — the text stays')
        }
        runs.push({ html, chars: text.length, bold: b !== undefined ? on(b) : regionBold, ink })
        chars += text.length
      }
      paras.push({ runs, chars, algn: pPr ? attr(pPr, 'algn') : undefined })
    }
    while (paras.length && paras[paras.length - 1].chars === 0) paras.pop()
    const all = paras.flatMap((p) => p.runs).filter((r) => r.chars > 0)
    if (all.length === 0) return {}

    const out: Partial<OutTableCell> = {}
    const allBold = all.every((r) => r.bold)
    if (allBold && !isHeader) out.bold = true
    let dom = all[0]
    for (const r of all) if (r.chars > dom.chars) dom = r
    const ink = dom.ink ?? regionInk
    if (ink !== regionInk) out.color = ink
    if (all.some((r) => (r.ink ?? regionInk) !== ink)) {
      note('approximated', 'table-formatting-flattened',
        'runs disagree on size/colour/face; the table carries the dominant run and cells their dominant colour')
    }
    let domPara = paras[0]
    for (const p of paras) if (p.chars > domPara.chars) domPara = p
    const a = domPara.algn
    if (a === 'ctr') out.align = 'center'
    else if (a === 'r') out.align = 'right'
    else if (a !== undefined && a !== 'l') {
      note('approximated', 'align-approximated', `algn="${a}" has no bento equivalent; emitted left-aligned`)
    }
    if (paras.some((p) => p.chars > 0 && (p.algn ?? 'l') !== (a ?? 'l'))) {
      note('approximated', 'align-flattened', 'paragraphs in one cell disagree on alignment; the cell carries the dominant paragraph’s')
    }
    out.html = paras.map((p) => p.runs.map((r) => (r.bold && !allBold && r.chars > 0 ? `<b>${r.html}</b>` : r.html)).join('')).join('<br>')
    return out
  }

  if (mergedSeen) {
    note('approximated', 'table-merged-cells',
      'merged cells have no bento counterpart — the content stays in the first cell, the cells it covered are left empty')
  }
  if (valignSeen) {
    note('approximated', 'table-valign-approximated',
      'cells anchored top or bottom are centred vertically — bento table cells are always middle-aligned')
  }

  // ---- table-wide style: dominant size/face, one border
  let domSize = 18
  let best = -1
  for (const [s, n] of sizes) if (n > best) { best = n; domSize = s }
  let domFace: string | undefined
  best = -1
  for (const [f, n] of faces) if (n > best) { best = n; domFace = f }
  if (sizes.size > 1 || faces.size > 1) {
    note('approximated', 'table-formatting-flattened',
      'runs disagree on size/colour/face; the table carries the dominant run and cells their dominant colour')
  }

  let border: Border | undefined
  if (borders.size) {
    let top = ''
    best = -1
    for (const [k, n] of borders) if (n > best) { best = n; top = k }
    if (top !== 'none') {
      const [color, width] = top.split('|')
      border = { color, width: Number(width) }
    }
    if (borders.size > 1) {
      note('approximated', 'table-borders-approximated',
        'cell borders vary by side or cell; bento draws one border colour and width around every cell')
    }
  } else border = whole?.border

  const style: Record<string, unknown> = {
    headerBg,
    headerColor: headerInk,
    borderColor: border?.color ?? 'transparent',
    borderWidth: border?.width ?? 0,
    cellPadX: pad?.x ?? 9.6,
    cellPadY: pad?.y ?? 4.8,
    fontSize: r2(domSize * (4 / 3)),
    color: baseInk,
    radius: 0,
  }
  const stack = domFace ? stackOf(domFace, ctx) : undefined
  if (stack) style.fontFamily = stack

  return {
    columns: cols.map((g) => ({ w: px(intAttr(g, 'w', 0)) || 1 })),
    rows,
    header,
    style,
  }
}

/** The r:id of a reference element (attr's prefix-insensitive match would
 *  also accept a plain @id). */
function rIdOf(el: XElem): string | undefined {
  for (const [k, v] of el.attrs) if (k !== 'id' && k.endsWith(':id')) return v
  return undefined
}
