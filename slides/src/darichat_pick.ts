import type { BentoDoc } from './model'

// darichat's AI edit mode: while armed, a click on the show names the element
// to the host instead of following its link or stepping the slide.
export function armPicker(doc: BentoDoc, send: (data: Record<string, unknown>) => void): (on: boolean) => void {
  let picking = false
  let hovered: HTMLElement | null = null
  const elementAt = (event: Event) =>
    (event.target as Element | null)?.closest?.<HTMLElement>('.bento-present-overlay .bento-el[data-el-id]') ?? null
  const hover = (el: HTMLElement | null) => {
    hovered?.classList.remove('darislides-pick')
    hovered = el
    hovered?.classList.add('darislides-pick')
  }
  document.addEventListener('pointermove', (event) => { if (picking) hover(elementAt(event)) }, true)
  document.addEventListener('click', (event) => {
    if (!picking) return
    event.preventDefault()
    event.stopPropagation()
    const el = elementAt(event)
    const section = el?.closest('section')
    if (!el || !section?.parentElement) return
    const slide = doc.slides[[...section.parentElement.children].indexOf(section)]
    if (!slide) return
    const element = slide.elements?.find((item) => item.id === el.dataset.elId)
    const rect = el.getBoundingClientRect()
    send({ type: 'picked', slide_id: slide.id, element_id: el.dataset.elId, element_type: element?.type ?? null,
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } })
  }, true)
  return (on: boolean) => {
    picking = on
    document.documentElement.classList.toggle('darislides-picking', on)
    if (!on) hover(null)
  }
}
