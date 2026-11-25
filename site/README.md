# codetiller.ai

The landing page and the documentation of codetiller. Next.js (App Router), Tailwind CSS 4, next-intl,
Motion; docs are MDX files. Every page is rendered at build time.

The site is its own pnpm root with its own lockfile: it is not part of the factory's workspace and never
enters the factory's image.

```bash
cd site
pnpm install
pnpm dev          # http://localhost:3000
pnpm build        # static pages + the proxy that serves the default language without a prefix
pnpm start
pnpm typecheck
```

Lint and format run from the repository root (`pnpm lint`, `pnpm format`).

## Where to change what

| What                                    | Where                                                           |
| --------------------------------------- | --------------------------------------------------------------- |
| Text of the landing page, the interface | `messages/en.json` (code in copy: backticks)                    |
| A docs page                             | `content/docs/en/<slug>.mdx`                                    |
| Order and groups of the docs sidebar    | `content/docs/nav.ts` (group titles: `ui.docs.groups` in copy)  |
| Address, repository links               | `src/site.config.ts`                                            |
| Colours, type, spacing                  | `src/app/globals.css` (one palette, light and dark in one line) |
| Commands and sample output on the page  | constants at the top of the component that shows them           |
| Sections of the landing page            | `src/app/[locale]/page.tsx`, `src/components/landing/`          |

### A docs page

```mdx
---
title: Short title
description: One sentence, shown under the title and used as the page's description.
---

Text, then `##` and `###` headings (they make the "On this page" list). No `#` heading.

<Callout type="note" title="Not built yet">

Markdown inside, with a blank line after the opening tag and before the closing one.

</Callout>
```

Add the slug to `content/docs/nav.ts`; the build fails when the file and the list disagree. Links between
pages are `/docs/<slug>`. Code fences need a language (`bash`, `yaml`, `text`, …). The search index is
built from the same files.

The docs describe the product: when a command, a flag or a limit changes in the code or in the root
`README.md`, the page that mentions it changes in the same commit.

### Another language

1. `src/i18n/routing.ts`: add the locale.
2. `messages/<locale>.json`: a translated copy of `en.json`.
3. Optionally `content/docs/<locale>/`: a docs page without a translation is shown in English.

The default language has no prefix (`/docs`), others have one (`/cs/docs`).

## Design rules

- One accent colour (`--signal`). It marks, it does not fill: numbers of sections, the moving token, the
  hover of the main button, and one block at the end of the page.
- Colours only by name (`bg-raised`, `text-ink-2`, `border-rule`), never a raw value in a component. A dark
  panel on a light page is `scheme-dark` on its element.
- Motion shows how the product works (a task moving through the stations, the audit, a verdict); it is not
  decoration. Everything honours `prefers-reduced-motion`, and the page is complete without scripts.
- Numbers and output on the page are what the product prints. Made-up data is labelled as an illustration.
- No claim the product cannot back: the Status section lists what is not built.

## Before it goes live

The site links to the repository (`src/site.config.ts`) and its install pages start with `git clone`. Both
need the repository to be public.

## Deploying

Any host that runs Next.js (`pnpm build`, `pnpm start`; Node ≥ 22). The proxy (`src/proxy.ts`) only maps the
unprefixed addresses to the default language, so a platform with edge middleware works as well. Set the
public address in `src/site.config.ts` (`url`): the sitemap, canonical links and the link card use it.
