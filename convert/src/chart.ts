// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A chart part (ppt/charts/chartN.xml, c:chartSpace) → the preset + option of
// a bento `chart` element. The frame, id and z-order are the orchestrator's.
//
// charts-lite (kernel/src/charts.ts) interprets an ECharts-SHAPED option:
// bar / line (+ areaStyle) / pie (+ inner radius) / scatter on one category
// axis with one or two value axes. So the mapping is:
//
//   c:barChart (col)       → bar series            c:lineChart    → line
//   c:barChart (bar = horizontal) → vertical bars, reported
//   c:areaChart            → line + opaque areaStyle
//   c:pieChart             → pie                   c:doughnutChart → pie with
//                                                   an inner radius (holeSize)
//   c:scatterChart         → scatter [[x, y]]
//   bar/line/area groups on one plot → one mixed option; a group on a second
//   value axis gets yAxisIndex 1 (charts-lite's dual axis)
//
// DATA COMES FROM THE CACHES ONLY (c:strCache / c:numCache / literals). The
// embedded workbook is never opened; a series without a cache cannot be
// imported and the chart keeps its placeholder. A blank point (ptCount larger
// than the cached points) becomes 0 — bar/line data must be plain numbers —
// and that is REPORTED, because a zero asserts something a gap does not.
//
// Everything else that charts-lite cannot draw (3D, radar, stock, bubble,
// surface, of-pie, pie mixed with anything) returns a failure the caller turns
// into the placeholder box + report. Nothing here throws on a bad part.

import { NS, kid, kids, attr, intAttr, textOf, descendants, type XElem } from './xml.ts'
import { resolveColor } from './theme.ts'
import type { InheritCtx, OutChart } from './types.ts'

export type ChartResult =
  | { ok: true; preset: OutChart['preset']; option: Record<string, unknown> }
  | { ok: false; code: string; detail: string }

type Kind = 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter'
const KINDS: Record<string, Kind> = {
  barChart: 'bar', lineChart: 'line', areaChart: 'area',
  pieChart: 'pie', doughnutChart: 'doughnut', scatterChart: 'scatter',
}

/** Total plotted points ceiling: keeps the option well under the untrusted
 *  gate's optionNodes bound (slides/src/untrusted.ts), which would otherwise
 *  drop the WHOLE option and leave an empty chart. */
const MAX_POINTS = 4000

const val = (el: XElem | undefined, name: string): string | undefined => {
  const k = el && kid(el, NS.c, name)
  return k ? attr(k, 'val') : undefined
}
const on = (v: string | undefined): boolean => v === '1' || v === 'true'

/** Cached points of a data reference (c:cat, c:val, c:tx, c:xVal, c:yVal):
 *  one slot per ptCount, undefined where the cache has no point. undefined
 *  overall when there is no cache to read. */
function pointsOf(ref: XElem | undefined): Array<string | undefined> | undefined {
  if (!ref) return undefined
  let cache: XElem | undefined
  let countHolder: XElem | undefined
  for (const k of kids(ref, NS.c)) {
    if (k.local === 'strLit' || k.local === 'numLit') cache = k
    else if (k.local === 'strRef') cache = kid(k, NS.c, 'strCache')
    else if (k.local === 'numRef') cache = kid(k, NS.c, 'numCache')
    else if (k.local === 'multiLvlStrRef') {
      const m = kid(k, NS.c, 'multiLvlStrCache')
      // multi-level categories: the first c:lvl is the innermost labels
      cache = m ? kids(m, NS.c, 'lvl')[0] : undefined
      countHolder = m
    }
    if (cache) break
  }
  if (!cache) return undefined
  const pts = kids(cache, NS.c, 'pt')
  const countEl = kid(countHolder ?? cache, NS.c, 'ptCount')
  const count = Math.min(MAX_POINTS, Math.max(countEl ? intAttr(countEl, 'val', 0) : 0, pts.length))
  const out: Array<string | undefined> = new Array(count).fill(undefined)
  for (const p of pts) {
    const i = intAttr(p, 'idx', -1)
    const v = kid(p, NS.c, 'v')
    if (i >= 0 && i < count && v) out[i] = textOf(v)
  }
  return out
}

function seriesName(ser: XElem, i: number): string {
  const tx = kid(ser, NS.c, 'tx')
  if (tx) {
    const pts = pointsOf(tx)
    if (pts && pts[0]) return pts[0]
    const v = kid(tx, NS.c, 'v')
    if (v && textOf(v)) return textOf(v)
  }
  return `Series ${i + 1}`
}

function richText(el: XElem): string {
  return descendants(el, NS.a, 't').map((t) => textOf(t)).join('').trim()
}

export function chartFrom(space: XElem, ctx: InheritCtx, where: string): ChartResult {
  const chart = kid(space, NS.c, 'chart')
  const plot = chart && kid(chart, NS.c, 'plotArea')
  if (!chart || !plot) return { ok: false, code: 'chart-data-missing', detail: 'the chart part has no c:plotArea — nothing to import' }

  const groups = kids(plot, NS.c).filter((k) => k.local.endsWith('Chart'))
  if (groups.length === 0) return { ok: false, code: 'chart-data-missing', detail: 'the chart part has no chart group — nothing to import' }
  for (const g of groups) {
    if (!KINDS[g.local]) {
      return { ok: false, code: 'chart-unsupported', detail: `c:${g.local} has no charts-lite counterpart (bar/line/area/pie/doughnut/scatter only) — a placeholder box marks the spot` }
    }
  }
  const kinds = groups.map((g) => KINDS[g.local])
  const pieLike = kinds.some((k) => k === 'pie' || k === 'doughnut')
  if ((pieLike || kinds.includes('scatter')) && groups.length > 1) {
    return { ok: false, code: 'chart-unsupported', detail: 'a combination chart with a pie or scatter group has no charts-lite counterpart — a placeholder box marks the spot' }
  }

  const { report, theme } = ctx
  const once = new Set<string>()
  const note = (verdict: 'approximated' | 'dropped', code: string, detail: string): void => {
    if (once.has(code)) return
    once.add(code)
    report.add(verdict, code, where, detail)
  }
  const accent = (i: number): string => theme.scheme[`accent${(i % 6) + 1}`] ?? '#4472C4'

  // ---- chart furniture
  const title = kid(chart, NS.c, 'title')
  if (title && val(chart, 'autoTitleDeleted') !== '1') {
    note('dropped', 'chart-title-dropped', 'charts-lite draws no chart title — the title is not imported (add a text element if it matters)')
  }
  const legendEl = kid(chart, NS.c, 'legend')
  let legend: Record<string, unknown> | undefined
  if (legendEl) {
    const pos = val(legendEl, 'legendPos') ?? 'r'
    legend = pos === 't' ? { top: 0 } : { bottom: 0 }
    if (pos !== 't' && pos !== 'b') {
      note('approximated', 'chart-legend-approximated', `legend position "${pos}" has no charts-lite counterpart — the legend sits below the plot`)
    }
  }

  const colorOf = (holder: XElem | undefined, line: boolean): string | undefined => {
    const spPr = holder && kid(holder, NS.c, 'spPr')
    if (!spPr) return undefined
    const ln = kid(spPr, NS.a, 'ln')
    const fromLn = ln ? resolveColor(kid(ln, NS.a, 'solidFill'), theme)?.css : undefined
    const fromFill = resolveColor(kid(spPr, NS.a, 'solidFill'), theme)?.css
    return line ? fromLn ?? fromFill : fromFill ?? fromLn
  }
  let blanks = false
  const numbers = (pts: Array<string | undefined>): number[] => pts.map((s) => {
    const n = s === undefined ? NaN : parseFloat(s)
    if (Number.isFinite(n)) return n
    blanks = true
    return 0
  })
  const labelsOn = (el: XElem | undefined): { cat: boolean; val: boolean; pct: boolean } => {
    const d = el && kid(el, NS.c, 'dLbls')
    return { cat: on(val(d, 'showCatName')), val: on(val(d, 'showVal')), pct: on(val(d, 'showPercent')) }
  }
  let totalPoints = 0

  // ---- pie / doughnut
  if (pieLike) {
    const g = groups[0]
    const sers = kids(g, NS.c, 'ser')
    const ser = sers[0]
    const vals = ser ? pointsOf(kid(ser, NS.c, 'val')) : undefined
    if (!ser || !vals) return { ok: false, code: 'chart-data-missing', detail: 'the pie series has no cached values (the embedded workbook is never read) — a placeholder box marks the spot' }
    if (sers.length > 1) note('dropped', 'chart-series-dropped', 'charts-lite draws one pie ring — only the first series is imported')
    const cats = pointsOf(kid(ser, NS.c, 'cat')) ?? []
    const values = numbers(vals)
    const vary = val(g, 'varyColors') !== '0'
    const own = colorOf(ser, false) ?? accent(0)
    const colors = values.map((_, i) => (vary ? accent(i) : own))
    for (const dPt of kids(ser, NS.c, 'dPt')) {
      const i = intAttr(kid(dPt, NS.c, 'idx') ?? dPt, 'val', -1)
      const c = colorOf(dPt, false)
      if (c && i >= 0 && i < colors.length) colors[i] = c
    }
    const lbl = labelsOn(ser).cat || labelsOn(ser).val || labelsOn(ser).pct ? labelsOn(ser) : labelsOn(g)
    const parts = [lbl.cat ? '{b}' : '', lbl.val ? '{c}' : '', lbl.pct ? '{d}%' : ''].filter(Boolean)
    const series: Record<string, unknown> = {
      type: 'pie',
      name: seriesName(ser, 0),
      label: parts.length ? { formatter: parts.join(': ') } : false,
      data: values.map((v, i) => ({ name: cats[i] ?? String(i + 1), value: v })),
    }
    if (kinds[0] === 'doughnut') {
      const hole = Math.min(90, Math.max(10, intAttr(kid(g, NS.c, 'holeSize') ?? g, 'val', 50)))
      series.radius = [`${Math.round(70 * hole) / 100}%`, '70%']
    }
    if (blanks) note('approximated', 'chart-blanks-zeroed', 'blank data points became 0 — charts-lite takes plain numbers')
    const option: Record<string, unknown> = { tooltip: { trigger: 'item' }, color: colors, series: [series] }
    if (legend) option.legend = legend
    return { ok: true, preset: 'pie', option }
  }

  // ---- scatter
  if (kinds[0] === 'scatter') {
    const g = groups[0]
    const style = val(g, 'scatterStyle') ?? 'marker'
    const series: Array<Record<string, unknown>> = []
    const colors: string[] = []
    for (const [i, ser] of kids(g, NS.c, 'ser').entries()) {
      const ys = pointsOf(kid(ser, NS.c, 'yVal'))
      if (!ys) return { ok: false, code: 'chart-data-missing', detail: 'a scatter series has no cached values (the embedded workbook is never read) — a placeholder box marks the spot' }
      const xsRaw = pointsOf(kid(ser, NS.c, 'xVal'))
      const yv = numbers(ys)
      const numericX = xsRaw !== undefined && xsRaw.every((s) => s === undefined || Number.isFinite(parseFloat(s)))
      const xv = numericX ? numbers(xsRaw!) : yv.map((_, j) => j + 1)
      totalPoints += yv.length
      series.push({ type: 'scatter', name: seriesName(ser, i), symbolSize: 10, data: yv.map((y, j) => [xv[j] ?? j + 1, y]) })
      colors.push(colorOf(ser, false) ?? accent(i))
      const spPr = kid(ser, NS.c, 'spPr')
      const ln = spPr && kid(spPr, NS.a, 'ln')
      if (style !== 'marker' && style !== 'none' && !(ln && kid(ln, NS.a, 'noFill'))) {
        note('approximated', 'chart-scatter-lines-dropped', 'scatter connecting lines have no charts-lite counterpart — only the points are drawn')
      }
    }
    if (series.length === 0) return { ok: false, code: 'chart-data-missing', detail: 'the scatter chart has no series — a placeholder box marks the spot' }
    if (totalPoints > MAX_POINTS) return { ok: false, code: 'chart-too-large', detail: `more than ${MAX_POINTS} data points — too large to import as a live chart` }
    if (blanks) note('approximated', 'chart-blanks-zeroed', 'blank data points became 0 — charts-lite takes plain numbers')
    const option: Record<string, unknown> = {
      tooltip: { trigger: 'item' }, xAxis: { type: 'value' }, yAxis: { type: 'value' }, color: colors, series,
    }
    if (legend) option.legend = legend
    return { ok: true, preset: 'scatter', option }
  }

  // ---- bar / line / area, possibly mixed, one or two value axes
  const valAxes = new Map<string, XElem>()
  for (const ax of kids(plot, NS.c, 'valAx')) {
    const id = val(ax, 'axId')
    if (id) valAxes.set(id, ax)
  }
  const catAxes = kids(plot, NS.c, 'catAx').concat(kids(plot, NS.c, 'dateAx'))
  if (catAxes.some((ax) => kid(ax, NS.c, 'title') && val(ax, 'delete') !== '1')) {
    note('dropped', 'chart-axis-title-dropped', 'charts-lite draws no category-axis title — it is not imported')
  }
  const axisIds: string[] = []
  const series: Array<Record<string, unknown>> = []
  const colors: string[] = []
  let cats: Array<string | undefined> | undefined
  let labelsSeen = false
  for (const [gi, g] of groups.entries()) {
    const kind = kinds[gi]
    const groupAx = kids(g, NS.c, 'axId').map((a) => attr(a, 'val') ?? '').find((id) => valAxes.has(id)) ?? ''
    let axisIndex = axisIds.indexOf(groupAx)
    if (axisIndex < 0) {
      if (axisIds.length >= 2) return { ok: false, code: 'chart-unsupported', detail: 'more than two value axes have no charts-lite counterpart — a placeholder box marks the spot' }
      axisIds.push(groupAx)
      axisIndex = axisIds.length - 1
    }
    if (kind === 'bar' && val(g, 'barDir') === 'bar') {
      note('approximated', 'chart-horizontal-approximated', 'horizontal bars have no charts-lite counterpart — drawn as vertical columns')
    }
    const grouping = val(g, 'grouping')
    if (grouping === 'stacked' || grouping === 'percentStacked') {
      note('approximated', 'chart-stacking-approximated', `${grouping} series have no charts-lite counterpart — drawn side by side / overlapping`)
    }
    const l = labelsOn(g)
    if (l.cat || l.val || l.pct) labelsSeen = true
    for (const ser of kids(g, NS.c, 'ser')) {
      const vals = pointsOf(kid(ser, NS.c, 'val'))
      if (!vals) return { ok: false, code: 'chart-data-missing', detail: 'a series has no cached values (the embedded workbook is never read) — a placeholder box marks the spot' }
      cats ??= pointsOf(kid(ser, NS.c, 'cat'))
      const sl = labelsOn(ser)
      if (sl.cat || sl.val || sl.pct) labelsSeen = true
      const i = series.length
      const color = colorOf(ser, kind === 'line') ?? accent(i)
      const s: Record<string, unknown> = { type: kind === 'bar' ? 'bar' : 'line', name: seriesName(ser, i), data: numbers(vals) }
      if (kind === 'area') s.areaStyle = { color }
      if (kind === 'line' && on(val(ser, 'smooth'))) s.smooth = true
      if (axisIndex > 0) s.yAxisIndex = axisIndex
      totalPoints += vals.length
      series.push(s)
      colors.push(color)
    }
  }
  if (series.length === 0) return { ok: false, code: 'chart-data-missing', detail: 'the chart has no series — a placeholder box marks the spot' }
  if (totalPoints > MAX_POINTS) return { ok: false, code: 'chart-too-large', detail: `more than ${MAX_POINTS} data points — too large to import as a live chart` }
  if (labelsSeen) note('dropped', 'chart-labels-dropped', 'charts-lite draws no data labels on bars/lines — they are not imported')
  if (blanks) note('approximated', 'chart-blanks-zeroed', 'blank data points became 0 — charts-lite takes plain numbers')

  const n = Math.max(0, ...series.map((s) => (s.data as number[]).length))
  const categories = Array.from({ length: n }, (_, i) => cats?.[i] ?? String(i + 1))
  const yAxes = axisIds.map((id) => {
    const ax = valAxes.get(id)
    const y: Record<string, unknown> = { type: 'value' }
    const scaling = ax && kid(ax, NS.c, 'scaling')
    const min = parseFloat(val(scaling, 'min') ?? '')
    const max = parseFloat(val(scaling, 'max') ?? '')
    if (Number.isFinite(min)) y.min = min
    if (Number.isFinite(max)) y.max = max
    const t = ax && val(ax, 'delete') !== '1' ? kid(ax, NS.c, 'title') : undefined
    const name = t ? richText(t) : ''
    if (name) y.name = name
    return y
  })
  const option: Record<string, unknown> = {
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: categories },
    yAxis: yAxes.length > 1 ? yAxes : yAxes[0] ?? { type: 'value' },
    color: colors,
    series,
  }
  if (legend) option.legend = legend
  return { ok: true, preset: kinds[0] === 'bar' ? 'bar' : 'line', option }
}
