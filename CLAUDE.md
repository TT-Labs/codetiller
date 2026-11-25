# codetiller

- pnpm workspaces; TS ESM (NodeNext, `.js` import suffixes); Biome for lint/format; Vitest tests next to source (`*.test.ts`).
- Deterministic around the agent: checkout, test injection, verify, score = plain code.
- Agent never sees hidden tests. Verification in fresh container.
- Config hash over fully resolved config (after `extends`) + prompt text.
- `store/schema.ts` is generated from `schema.sql` — keep in sync (test enforces).
- `site/` = codetiller.ai (landing + docs, Next.js, own pnpm root). Docs (`site/content/docs`) describe the product: a changed command, flag or limit changes its docs page in the same commit.
