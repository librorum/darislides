import { addPack } from '../../kernel/src/i18n.ts'
import { label, strings } from './i18n/packs/ko'

export function registerDarislidesLocale(): void {
  addPack({ app: 'darislides', lang: 'ko', label, strings }, 'darislides')
}
