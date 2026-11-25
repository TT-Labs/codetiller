import { codeToHtml } from 'shiki'

/** Both themes in one markup (CSS picks by colour scheme): see `.shiki` in globals.css. */
export const SHIKI_THEMES = { light: 'vitesse-light', dark: 'vitesse-dark' } as const

export function highlight(code: string, lang: string): Promise<string> {
  return codeToHtml(code.replace(/\n$/, ''), {
    lang,
    themes: SHIKI_THEMES,
    defaultColor: false,
  })
}
