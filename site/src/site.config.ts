/** Facts about the site that are not copy: one place to change them. Copy lives in messages/. */
export const site: {
  name: string
  url: string
  /** the public repository; null = its links are left out of the site */
  github: string | null
  /** where "Edit this page" points (the docs directory on the default branch); null = no link */
  docsSource: string | null
  license: string
} = {
  name: 'codetiller',
  url: 'https://codetiller.ai',
  github: 'https://github.com/TT-Labs/codetiller',
  docsSource: 'https://github.com/TT-Labs/codetiller/edit/main/site/content/docs',
  license: 'Apache-2.0',
}
