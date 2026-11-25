/**
 * The docs sidebar: groups in order, pages in order. A page is `content/docs/<locale>/<slug>.mdx`;
 * `index` is /docs itself. Group titles are copy: `ui.docs.groups` in messages/<locale>.json.
 * The build fails when a slug here has no file, or a file is not listed here.
 */
export const nav = [
  { group: 'start', pages: ['index', 'quickstart', 'concepts'] },
  { group: 'install', pages: ['install-docker', 'install-kubernetes', 'operations'] },
  { group: 'use', pages: ['repositories', 'tasks', 'pull-requests', 'skills', 'configuration'] },
  { group: 'trust', pages: ['trust-boundary', 'verification'] },
  { group: 'evals', pages: ['evals'] },
  { group: 'reference', pages: ['cli'] },
] as const

export type NavGroup = (typeof nav)[number]['group']
