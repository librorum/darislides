// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The .pptx orchestrator — package in, ONE bento/slides document + fidelity
// report out. All the domain knowledge lives in the sibling modules (theme,
// inherit, media, text, shapes); this file owns the walks that stitch them
// together, and the walks are where a converter quietly loses whole decks:
//
//   - PART ROUTING IS RELS, NEVER NAMES. slide → layout → master → theme is a
//     chain of .rels hops; guessing "slideLayout1.xml" works on the demo file
//     and breaks on every deck with 2–4 masters (all six census decks).
//   - SLIDE ORDER IS p:sldIdLst ORDER, and z-order is spTree document order —
//     both formats agree, so the walk just has to not reorder anything.
//   - mc:AlternateContent is resolved with an EMPTY understood set: every
//     mc:Choice in the census requires an extension namespace (p14 morph
//     transitions and friends) whose semantics we do not implement, and the
//     Fallback is the producer's own hand-built downlevel rendering. Taking
//     it is strictly more honest than half-reading a Choice — and an mc-blind
//     walk would import Choice AND Fallback, i.e. everything twice.
//   - transition is ALWAYS 'none'. slides' own constructors default to 'fade'
//     while 71 of 79 census slides specify no transition (a hard cut); the
//     corpus's only real transition is Morph, and a failed morph pairing
//     degrades WORSE than a cut (spike: unwanted whole-slide fade). M0
//     imports no motion at all.
//   - PRUNE. 500 layout parts serve 79 slides — ~85% of the package is dead
//     template. Layouts are resolved through (inherit.ts) but never imported
//     as doc.layouts, and only media an imported slide actually references is
//     registered, or the emitted file is megabytes of unreachable base64.
//
// Element ids are DETERMINISTIC: `s<slideIndex>-<cNvPr id>` — the scheme
// shapes.ts mints, which is also what makes connector a:stCxn/a:endCxn refs
// resolve without a lookup table. The box-with-text split emits the text half
// as `s<n>-<spId>-t` immediately after its shape (later paints above), welded
// by groupId. Ids are unique per slide only, by design (the morph idiom).

import { readZip, type ZipParts } from '../../kernel/src/convert/zip.ts'
import {
  NS, parseXml, kid, kids, attr, intAttr, textOf, resolveAlternate, type XElem,
} from './xml.ts'
import { Report } from './report.ts'
import { parseTheme, resolveColor, resolveFillRef } from './theme.ts'
import { resolveFrame, effectivePhType, textDefaults, labeledChain } from './inherit.ts'
import {
  parseRels, parseContentTypes, AssetStore, imageFrom, type Rel, type ContentTypes,
} from './media.ts'
import { textFrom, type TextDeps } from './text.ts'
import { shapeFrom, groupChildren, type ShapeDeps, type GroupFrame } from './shapes.ts'
import { tableFrom } from './table.ts'
import { chartFrom } from './chart.ts'
import {
  EMU_PER_PX, METRIC_SUBSTITUTES, safeFace, cssFace,
  type ConvertResult, type OutDoc, type OutSlide, type OutElement, type OutShape, type OutImage,
  type InheritCtx, type ThemeCtx,
} from './types.ts'

const DC = 'http://purl.org/dc/elements/1.1/'
const dec = new TextDecoder()

/** EMU → px, 1/100px — the engine-wide convention media.ts set. */
const px = (emu: number): number => Math.round((emu / EMU_PER_PX) * 100) / 100
const r2 = (v: number): number => Math.round(v * 100) / 100

// --- package plumbing --------------------------------------------------------

function xmlOf(parts: ZipParts, name: string): XElem | undefined {
  const bytes = parts.get(name.replace(/^\//, ''))
  return bytes ? parseXml(dec.decode(bytes)) : undefined
}

/** The .rels for one part ('' = the package root → _rels/.rels). Missing or
 *  absent .rels reads as no relationships, never as an error — plenty of
 *  valid parts have none. */
function relsOf(parts: ZipParts, partName: string): Map<string, Rel> {
  const slash = partName.lastIndexOf('/')
  const dir = slash < 0 ? '' : partName.slice(0, slash + 1)
  const base = slash < 0 ? partName : partName.slice(slash + 1)
  const xml = xmlOf(parts, `${dir}_rels/${base}.rels`)
  return xml ? parseRels(xml, dir) : new Map()
}

/** First internal relationship whose type ends with `suffix` (the OPC type
 *  URIs all share long prefixes; the tail is the discriminator). */
function relOfType(rels: Map<string, Rel>, suffix: string): Rel | undefined {
  for (const r of rels.values()) if (!r.mode && r.type.endsWith(suffix)) return r
  return undefined
}

/** The r:id of a reference element. NOT attr(el, 'id'): p:sldId carries BOTH
 *  @id (the slide's number) and @r:id, and attr's exact-name-first match
 *  returns the wrong one. */
function rIdOf(el: XElem): string | undefined {
  for (const [k, v] of el.attrs) if (k !== 'id' && k.endsWith(':id')) return v
  return undefined
}

// --- shape bookkeeping -------------------------------------------------------

function cNvPrOf(el: XElem): XElem | undefined {
  for (const c of kids(el)) {
    const cnv = kid(c, NS.p, 'cNvPr')
    if (cnv) return cnv
  }
  return undefined
}

const cNvPrIdOf = (el: XElem): string => {
  const c = cNvPrOf(el)
  return c ? attr(c, 'id') ?? '0' : '0'
}

function whereOf(el: XElem, n: number): string {
  const c = cNvPrOf(el)
  const name = c && attr(c, 'name')
  return `slide ${n} / sp ${name ? `"${name}"` : c ? attr(c, 'id') ?? '?' : '?'}`
}

/** See the header: Choices all require extensions we do not implement, so the
 *  resolution set stays empty and every mc lands on its Fallback. */
const MC_NOTHING = new Set<string>()

function flattenMc(children: Array<XElem | string>): XElem[] {
  const out: XElem[] = []
  for (const c of children) {
    if (typeof c === 'string') continue
    if (c.ns === NS.mc && c.local === 'AlternateContent') {
      out.push(...flattenMc(resolveAlternate(c, MC_NOTHING)))
    } else out.push(c)
  }
  return out
}

// --- background --------------------------------------------------------------

const BG_FILLS = new Set(['solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'noFill'])

/** Cheapest honest read of a gradient when the target is one colour: the
 *  lowest-position stop (the gradient's visual anchor). */
function lowestStop(grad: XElem, theme: ThemeCtx, phClr: string | undefined): string | undefined {
  const lst = kid(grad, NS.a, 'gsLst')
  if (!lst) return undefined
  let best: string | undefined
  let bestPos = Infinity
  for (const gs of kids(lst, NS.a, 'gs')) {
    const pos = intAttr(gs, 'pos')
    const c = resolveColor(gs, theme, phClr)
    if (c && pos < bestPos) { best = c.css; bestPos = pos }
  }
  return best
}

/**
 * slide.background from p:bg, walked slide → layout → master; the FIRST level
 * declaring a p:bg settles the question (a slide-level bg overrides, never
 * merges). bento's background is one colour, so a gradient flattens to its
 * first stop with a report, and a picture background is dropped loudly.
 * Default white — the one colour a missing background actually paints.
 */
function backgroundOf(ctx: InheritCtx, n: number, pictureCarried = false): string {
  const report = ctx.report
  const where = `slide ${n}`
  const levels: Array<{ root: XElem | undefined; from: 'own' | 'layout' | 'master' }> = [
    { root: ctx.slide, from: 'own' },
    { root: ctx.layout, from: 'layout' },
    { root: ctx.master, from: 'master' },
  ]
  for (const { root, from } of levels) {
    const cSld = root && kid(root, NS.p, 'cSld')
    const bg = cSld && kid(cSld, NS.p, 'bg')
    if (!bg) continue

    const bgPr = kid(bg, NS.p, 'bgPr')
    if (bgPr) {
      const fill = kids(bgPr, NS.a).find((k) => BG_FILLS.has(k.local))
      if (!fill || fill.local === 'noFill') {
        report.trace('background', from)
        return '#FFFFFF'
      }
      if (fill.local === 'solidFill') {
        const c = resolveColor(fill, ctx.theme)
        if (c) { report.trace('background', from); return c.css }
        report.add('dropped', 'background-unresolved', where,
          'slide background colour did not resolve — painted white')
        return '#FFFFFF'
      }
      if (fill.local === 'gradFill') {
        const c = lowestStop(fill, ctx.theme, undefined)
        if (c) {
          report.add('approximated', 'background-approximated', where,
            'gradient background flattened to its first stop — slide.background is one colour')
          report.trace('background', from)
          return c
        }
        report.add('dropped', 'background-unresolved', where,
          'gradient background had no resolvable stop — painted white')
        return '#FFFFFF'
      }
      if (fill.local === 'blipFill' && pictureCarried) {
        // carried as a full-bleed image element (ConvertOptions.chrome)
        report.trace('background', from)
        return '#FFFFFF'
      }
      report.add('dropped', 'background-image-dropped', where,
        `a:${fill.local} slide background has no bento counterpart — painted white`)
      return '#FFFFFF'
    }

    const bgRef = kid(bg, NS.p, 'bgRef')
    if (bgRef) {
      const idx = intAttr(bgRef, 'idx')
      if (idx === 0) { report.trace('background', from); return '#FFFFFF' }
      // bgRef's colour child is the phClr; resolveFillRef wants bare hex
      const ph = resolveColor(bgRef, ctx.theme)
      const phClr = ph && ph.css.startsWith('#') ? ph.css : '#FFFFFF'
      const got = resolveFillRef(idx, phClr, ctx.theme)
      if (got) {
        if (got.kind === 'none') { report.trace('background', from); return '#FFFFFF' }
        if (got.kind === 'solid') { report.trace('background', 'theme'); return got.color.css }
        if (got.el.local === 'gradFill') {
          const c = lowestStop(got.el, ctx.theme, got.phClr)
          if (c) {
            report.add('approximated', 'background-approximated', where,
              'theme gradient background flattened to its first stop — slide.background is one colour')
            report.trace('background', 'theme')
            return c
          }
        }
      }
      report.add('dropped', 'background-unresolved', where,
        `a:bgRef idx="${idx}" did not resolve — painted white`)
      return '#FFFFFF'
    }
  }
  report.trace('background', 'default')
  return '#FFFFFF'
}

/**
 * ConvertOptions.chrome: a picture background (p:bg a:blipFill), walked
 * slide → layout → master with the same first-p:bg-wins rule as backgroundOf,
 * as a full-bleed image under everything else. Its blip resolves through the
 * rels of the part that declares it.
 */
function backgroundPictureOf(
  levels: Array<{ root: XElem | undefined; rels: Map<string, Rel> }>,
  assets: AssetStore,
  size: { width: number; height: number },
  n: number,
): OutImage | undefined {
  for (const { root, rels } of levels) {
    const cSld = root && kid(root, NS.p, 'cSld')
    const bg = cSld && kid(cSld, NS.p, 'bg')
    if (!bg) continue
    const bgPr = kid(bg, NS.p, 'bgPr')
    const fill = bgPr && kid(bgPr, NS.a, 'blipFill')
    const blip = fill && kid(fill, NS.a, 'blip')
    const relId = blip && attr(blip, 'embed')
    const rel = relId ? rels.get(relId) : undefined
    const key = rel && !rel.mode ? assets.register(rel.target) : undefined
    if (!key) return undefined
    return {
      id: `s${n}-bg`, type: 'image', src: `asset:${key}`, fit: 'fill',
      x: 0, y: 0, w: size.width, h: size.height, rotation: 0, opacity: 1,
    }
  }
  return undefined
}

/** Whether a shape is a placeholder (p:ph in whichever nv*Pr it carries). */
function isPlaceholder(el: XElem): boolean {
  for (const c of kids(el)) {
    const nv = kid(c, NS.p, 'nvPr')
    if (nv) return kid(nv, NS.p, 'ph') !== undefined
  }
  return false
}

const PH_ROLES: Record<string, string> = { title: 'title', ctrTitle: 'title', subTitle: 'subtitle', body: 'body' }

// --- notes -------------------------------------------------------------------

/** Plain text from a notesSlide part: the body placeholder(s) only. sldImg is
 *  the slide's own thumbnail (census: 14) and sldNum/hdr/ftr/dt are page
 *  furniture — none of them are the speaker's words. */
function notesTextOf(notesXml: XElem): string {
  const cSld = kid(notesXml, NS.p, 'cSld')
  const tree = cSld && kid(cSld, NS.p, 'spTree')
  if (!tree) return ''
  const out: string[] = []
  for (const sp of kids(tree, NS.p, 'sp')) {
    let phType = ''
    for (const c of kids(sp)) {
      const nv = kid(c, NS.p, 'nvPr')
      const ph = nv && kid(nv, NS.p, 'ph')
      if (ph) { phType = attr(ph, 'type') ?? ''; break }
    }
    if (phType !== 'body') continue
    const tb = kid(sp, NS.p, 'txBody')
    if (!tb) continue
    const text = kids(tb, NS.a, 'p').map((p) => textOf(p)).join('\n').trim()
    if (text) out.push(text)
  }
  return out.join('\n')
}

// --- misc --------------------------------------------------------------------

/** The theme face as a CSS stack: the original first (a machine that has the
 *  real font uses it), its metric-compatible substitute second. A face that is
 *  not safe to write into CSS (types.ts safeFace) is left out entirely. */
function fontStack(face: string): string {
  const safe = safeFace(face)
  if (!safe) return 'sans-serif'
  const sub = METRIC_SUBSTITUTES[safe]
  return sub ? `${cssFace(safe)}, ${cssFace(sub)}, sans-serif` : `${cssFace(safe)}, sans-serif`
}

function picFlipped(pic: XElem): boolean {
  const spPr = kid(pic, NS.p, 'spPr')
  const xf = spPr && kid(spPr, NS.a, 'xfrm')
  const f = (v: string | undefined): boolean => v === '1' || v === 'true'
  return xf !== undefined && (f(attr(xf, 'flipH')) || f(attr(xf, 'flipV')))
}

function coreTitle(parts: ZipParts, rootRels: Map<string, Rel>): string | undefined {
  const rel = relOfType(rootRels, '/core-properties')
  const core = xmlOf(parts, rel ? rel.target : 'docProps/core.xml')
  if (!core) return undefined
  const t = kid(core, DC, 'title')
  const s = t ? textOf(t).trim() : ''
  return s || undefined
}

/** A theme for packages whose chain is broken: empty scheme, Calibri faces.
 *  Lazily built so the module costs nothing to import. */
let emptyThemeCache: ThemeCtx | undefined
const emptyTheme = (): ThemeCtx =>
  (emptyThemeCache ??= parseTheme(parseXml(`<a:theme xmlns:a="${NS.a}"/>`), undefined))

interface MasterBundle { theme: ThemeCtx; themeXml?: XElem }

// --- the conversion ----------------------------------------------------------

export interface ConvertOptions {
  /**
   * Template import: also carry each slide's inherited CHROME — the master's
   * and layout's non-placeholder shapes and pictures (honouring showMasterSp)
   * and a picture background as a full-bleed image — painted under the
   * slide's own shapes, and tag title/subtitle/body placeholders with `role`.
   * Off by default: an ordinary deck import keeps the PRUNE rule (header).
   * Chrome ids are `s<n>-m<id>` (master) and `s<n>-l<id>` (layout), the
   * background `s<n>-bg`.
   */
  chrome?: boolean
}

/**
 * Convert one .pptx to a bento/slides document. Throws (ZipError / XmlError /
 * Error) only for a package that is not a presentation at all; everything
 * recoverable lands in the report instead.
 */
export async function convertPptx(bytes: Uint8Array, opts: ConvertOptions = {}): Promise<ConvertResult> {
  const report = new Report()
  const parts = await readZip(bytes)
  const ctRoot = xmlOf(parts, '[Content_Types].xml')
  const types: ContentTypes | undefined = ctRoot ? parseContentTypes(ctRoot) : undefined
  const assets = new AssetStore(parts, types)

  const rootRels = relsOf(parts, '')
  const presPart = relOfType(rootRels, '/officeDocument')?.target ?? 'ppt/presentation.xml'
  const pres = xmlOf(parts, presPart)
  if (!pres) throw new Error('this file is not a PowerPoint package — it has no presentation part')
  const presRels = relsOf(parts, presPart)
  // ppt/tableStyles.xml, read once and only if a table asks for it
  let tableStylesXml: XElem | undefined | null = null
  const tableStyles = (): XElem | undefined => {
    if (tableStylesXml === null) {
      const rel = relOfType(presRels, '/tableStyles')
      try { tableStylesXml = rel ? xmlOf(parts, rel.target) : undefined } catch { tableStylesXml = undefined }
    }
    return tableStylesXml
  }

  // 12192000×6858000 EMU / 9525 = 1280×720 EXACTLY — converted, never assumed
  // (4:3 decks are 9144000×6858000 → 960×720 through the same arithmetic).
  const sldSz = kid(pres, NS.p, 'sldSz')
  const size = {
    width: Math.round((sldSz ? intAttr(sldSz, 'cx', 12192000) : 12192000) / EMU_PER_PX),
    height: Math.round((sldSz ? intAttr(sldSz, 'cy', 6858000) : 6858000) / EMU_PER_PX),
  }

  const masterCache = new Map<string, MasterBundle>()
  let deckTheme: ThemeCtx | undefined
  let titleText: string | undefined
  const slides: OutSlide[] = []

  const sldIdLst = kid(pres, NS.p, 'sldIdLst')
  const sldIds = sldIdLst ? kids(sldIdLst, NS.p, 'sldId') : []
  let n = 0
  for (const sldId of sldIds) {
    n++ // 1-based SOURCE position — ids stay deterministic even past a bad slide
    const relId = rIdOf(sldId)
    const rel = relId ? presRels.get(relId) : undefined
    const slidePart = rel && !rel.mode ? rel.target : undefined
    const slideXml = slidePart ? xmlOf(parts, slidePart) : undefined
    if (!slidePart || !slideXml) {
      report.add('dropped', 'slide-missing', `slide ${n}`,
        'a slide named by p:sldIdLst is missing from the package')
      continue
    }
    const slideRels = relsOf(parts, slidePart)

    // ---- the inheritance chain: layout → master → theme, all via rels
    const layoutRel = relOfType(slideRels, '/slideLayout')
    const layoutXml = layoutRel ? xmlOf(parts, layoutRel.target) : undefined
    if (layoutRel && !layoutXml) {
      report.add('dropped', 'part-missing', `slide ${n}`, `layout part missing: ${layoutRel.target}`)
    }
    const layoutRels = layoutXml && layoutRel ? relsOf(parts, layoutRel.target) : new Map<string, Rel>()
    const masterRel = relOfType(layoutRels, '/slideMaster')
    const masterXml = masterRel ? xmlOf(parts, masterRel.target) : undefined
    if (masterRel && !masterXml) {
      report.add('dropped', 'part-missing', `slide ${n}`, `master part missing: ${masterRel.target}`)
    }

    let bundle: MasterBundle = { theme: emptyTheme() }
    if (masterRel && masterXml) {
      const cached = masterCache.get(masterRel.target)
      if (cached) bundle = cached
      else {
        const masterRels = relsOf(parts, masterRel.target)
        const themeRel = relOfType(masterRels, '/theme')
        const themeXml = themeRel ? xmlOf(parts, themeRel.target) : undefined
        if (themeRel && !themeXml) {
          report.add('dropped', 'part-missing', `slide ${n}`, `theme part missing: ${themeRel.target}`)
        }
        bundle = themeXml
          ? { theme: parseTheme(themeXml, kid(masterXml, NS.p, 'clrMap')), themeXml }
          : { theme: emptyTheme() }
        masterCache.set(masterRel.target, bundle)
      }
    }
    // p:clrMapOvr re-routes the SAME scheme for this slide only
    let theme = bundle.theme
    const ovr = kid(slideXml, NS.p, 'clrMapOvr')
    const mapping = ovr && kid(ovr, NS.a, 'overrideClrMapping')
    if (mapping && bundle.themeXml) theme = parseTheme(bundle.themeXml, mapping)
    deckTheme ??= theme

    const ctx: InheritCtx = { slide: slideXml, theme, report }
    if (layoutXml) ctx.layout = layoutXml
    if (masterXml) ctx.master = masterXml

    // ---- elements, in spTree document order (z-order in both formats)
    const cSldEl = kid(slideXml, NS.p, 'cSld')
    const spTree = cSldEl && kid(cSldEl, NS.p, 'spTree')
    const elements: OutElement[] = []
    // the rels images resolve through — the slide's, or a chrome part's
    let partRels = slideRels

    // every cNvPr id on the slide — connector refs outside this set are dangling
    const spIds = new Set<string>()
    const collectIds = (list: Array<XElem | string>): void => {
      for (const e of flattenMc(list)) {
        if (e.ns !== NS.p) continue
        if (e.local === 'grpSp') collectIds(e.children)
        else if (e.local === 'sp' || e.local === 'pic' || e.local === 'cxnSp' || e.local === 'graphicFrame') {
          spIds.add(cNvPrIdOf(e))
        }
      }
    }
    if (spTree) collectIds(spTree.children)

    let refitPending = false
    const baseTextDeps: TextDeps = {
      effectivePhType, textDefaults, resolveFrame, labeledChain, resolveColor,
      needsRefit: () => { refitPending = true },
    }

    const emit = (el: XElem, frame?: GroupFrame, groupId?: string): void => {
      if (el.ns !== NS.p) return
      const local = el.local

      if (local === 'sp' || local === 'cxnSp') {
        const spId = cNvPrIdOf(el)
        const deps: ShapeDeps = { slideIndex: n, spIds }
        if (frame) deps.frame = frame
        if (groupId) deps.groupId = groupId
        const res = shapeFrom(el, ctx, deps)
        if (res) elements.push(res.shape)
        if (local === 'cxnSp') return // connectors carry no txBody

        // an untitled package is named by its first title placeholder's text
        if (titleText === undefined) {
          const t = effectivePhType(el, ctx)
          if (t === 'title' || t === 'ctrTitle') {
            const tb = kid(el, NS.p, 'txBody')
            const s = tb ? textOf(tb).replace(/\s+/g, ' ').trim() : ''
            if (s) titleText = s
          }
        }

        refitPending = false
        // group members carry their COMPOSED frame; textFrom must see it, not
        // the leaf's own local-coordinate xfrm
        const tdeps: TextDeps = frame
          ? { ...baseTextDeps, resolveFrame: () => ({ ...frame, from: 'own' as const }) }
          : baseTextDeps
        const text = textFrom(el, ctx, tdeps)
        if (text) {
          if (res) {
            // the box-with-text split: text right after its shape (later
            // paints above), welded by groupId so they move as one object
            const gid = res.textGroupId ?? res.shape.groupId ?? `s${n}-${spId}-g`
            res.shape.groupId = gid
            text.groupId = gid
            text.id = `s${n}-${spId}-t`
          } else {
            text.id = `s${n}-${spId}`
            if (groupId) text.groupId = groupId
          }
          if (opts.chrome) {
            const role = PH_ROLES[effectivePhType(el, ctx)]
            if (role) text.role = role
          }
          elements.push(text)
          if (refitPending) {
            report.add('approximated', 'text-needs-refit', `slide ${n}`,
              'text box relies on autofit (or substituted font metrics) — the host must re-measure through the shell')
          }
        }
        return
      }

      if (local === 'pic') {
        const where = whereOf(el, n)
        const img = imageFrom(el, ctx, partRels, assets, where)
        if (!img) return
        img.id = `s${n}-${cNvPrIdOf(el)}`
        if (frame) {
          img.x = px(frame.x); img.y = px(frame.y)
          img.w = px(frame.w); img.h = px(frame.h)
          img.rotation = r2(frame.rotation)
        } else if (img.w === 0 && img.h === 0) {
          // picture placeholder (census: 122 p:ph type=pic) — the frame lives
          // up the chain, exactly as for shapes
          const fr = resolveFrame(el, ctx)
          img.x = px(fr.x); img.y = px(fr.y)
          img.w = px(fr.w); img.h = px(fr.h)
          img.rotation = r2(fr.rotation)
        }
        if (groupId) img.groupId = groupId
        if (frame ? frame.flipH || frame.flipV : picFlipped(el)) {
          report.add('approximated', 'flip-dropped', where,
            'flipH/flipV on a picture has no bento field — rendered unflipped')
        }
        elements.push(img)
        return
      }

      if (local === 'grpSp') {
        const deps: ShapeDeps = { slideIndex: n, spIds }
        if (groupId) deps.groupId = groupId
        for (const leaf of groupChildren(el, ctx, deps)) emit(leaf.el, leaf.frame, leaf.groupId)
        return
      }

      if (local === 'graphicFrame') {
        // tables and charts become bento table/chart elements; anything that
        // cannot be read keeps a placeholder box and the report says why
        const where = whereOf(el, n)
        const id = `s${n}-${cNvPrIdOf(el)}`
        const fr: GroupFrame = frame ?? resolveFrame(el, ctx)
        const base = {
          id, x: px(fr.x), y: px(fr.y), w: px(fr.w), h: px(fr.h),
          rotation: r2(fr.rotation), opacity: 1,
          ...(groupId ? { groupId } : {}),
        }
        const graphic = kid(el, NS.a, 'graphic')
        const gd = graphic && kid(graphic, NS.a, 'graphicData')
        const tbl = gd && kid(gd, NS.a, 'tbl')
        const chartRef = gd && kids(gd).find((c) => c.ns === NS.c && c.local === 'chart')
        if (tbl) {
          const body = tableFrom(tbl, ctx, { rels: partRels, styles: tableStyles(), where })
          if (body) { elements.push({ ...base, type: 'table', ...body }); return }
          report.add('dropped', 'table-empty', where,
            'the table has no grid columns or rows — a placeholder box marks the spot')
        } else if (chartRef) {
          const rid = rIdOf(chartRef)
          const rel = rid ? partRels.get(rid) : undefined
          let space: XElem | undefined
          try { space = rel && !rel.mode ? xmlOf(parts, rel.target) : undefined } catch { space = undefined }
          const got = space ? chartFrom(space, ctx, where) : undefined
          if (got?.ok) {
            elements.push({ ...base, type: 'chart', preset: got.preset, option: got.option })
            return
          }
          if (got) report.add('dropped', got.code, where, got.detail)
          else report.add('dropped', 'chart-missing', where,
            'the chart part named by the graphicFrame is missing from the package — a placeholder box marks the spot')
        } else {
          report.add('dropped', 'graphic-dropped', where,
            `graphicFrame content (${gd ? attr(gd, 'uri') ?? 'unknown' : 'empty'}) has no importer — a placeholder box marks the spot`)
        }
        const box: OutShape = {
          ...base, type: 'shape', shape: 'rect',
          fill: 'transparent', stroke: '#9AA3AD', strokeWidth: 1, radius: 0,
          strokeStyle: 'dashed',
        }
        elements.push(box)
      }
    }
    let bgPicture: OutImage | undefined
    if (opts.chrome) {
      const masterRels = masterRel && masterXml ? relsOf(parts, masterRel.target) : new Map<string, Rel>()
      bgPicture = backgroundPictureOf([
        { root: slideXml, rels: slideRels },
        { root: layoutXml, rels: layoutRels },
        { root: masterXml, rels: masterRels },
      ], assets, size, n)
      if (bgPicture) elements.push(bgPicture)
      const chrome: Array<{ root: XElem; rels: Map<string, Rel>; tag: string }> = []
      if (attr(slideXml, 'showMasterSp') !== '0') {
        if (masterXml && (!layoutXml || attr(layoutXml, 'showMasterSp') !== '0')) {
          chrome.push({ root: masterXml, rels: masterRels, tag: 'm' })
        }
        if (layoutXml) chrome.push({ root: layoutXml, rels: layoutRels, tag: 'l' })
      }
      const prefix = `s${n}-`
      const retag = (v: string, tag: string): string => (v.startsWith(prefix) ? prefix + tag + v.slice(prefix.length) : v)
      for (const { root, rels, tag } of chrome) {
        const cSld = kid(root, NS.p, 'cSld')
        const tree = cSld && kid(cSld, NS.p, 'spTree')
        if (!tree) continue
        const start = elements.length
        partRels = rels
        for (const el of flattenMc(tree.children)) if (!isPlaceholder(el)) emit(el)
        partRels = slideRels
        // chrome ids must not collide with the slide's own cNvPr ids
        for (const e of elements.slice(start)) {
          e.id = retag(e.id, tag)
          if (e.groupId) e.groupId = retag(e.groupId, tag)
          if (e.type === 'shape') {
            if (e.from) e.from.el = retag(e.from.el, tag)
            if (e.to) e.to.el = retag(e.to.el, tag)
          }
        }
      }
    }
    if (spTree) for (const el of flattenMc(spTree.children)) emit(el)

    // ---- notes
    let notes = ''
    const notesRel = relOfType(slideRels, '/notesSlide')
    if (notesRel) {
      const notesXml = xmlOf(parts, notesRel.target)
      if (notesXml) notes = notesTextOf(notesXml)
      else report.add('dropped', 'part-missing', `slide ${n}`, `notes part missing: ${notesRel.target}`)
    }

    const slide: OutSlide = {
      id: `s${n}`,
      name: (cSldEl && attr(cSldEl, 'name')) || `Slide ${n}`,
      background: backgroundOf(ctx, n, bgPicture !== undefined),
      transition: 'none',
      notes,
      elements,
    }
    if (attr(slideXml, 'show') === '0') slide.hidden = true
    slides.push(slide)
  }

  // parseDoc refuses a slideless document; a blank page is the honest minimum
  if (slides.length === 0) {
    report.add('dropped', 'deck-empty', 'deck',
      'the package names no importable slides — one blank slide emitted so the document loads')
    slides.push({
      id: 's1', name: 'Slide 1', background: '#FFFFFF',
      transition: 'none', notes: '', elements: [],
    })
  }

  const scheme = deckTheme ? deckTheme.scheme : {}
  const doc: OutDoc = {
    format: 'bento/slides',
    version: '1.0.0',
    title: coreTitle(parts, rootRels) ?? titleText ?? 'Imported deck',
    size,
    theme: {
      background: scheme['bg1'] ?? '#FFFFFF',
      color: scheme['tx1'] ?? '#000000',
      accent: scheme['accent1'] ?? scheme['tx1'] ?? '#000000',
      fontFamily: fontStack(deckTheme ? deckTheme.minorFont : 'Calibri'),
    },
    assets: assets.assets(),
    fonts: null,
    slides,
  }
  return { doc, report: report.build() }
}
