# codetiller

- pnpm workspaces; TS ESM (NodeNext, `.js` import suffixes); Biome for lint/format; Vitest tests next to source (`*.test.ts`).
- Deterministic around the agent: checkout, test injection, verify, score = plain code.
- Agent never sees hidden tests. Verification in fresh container.
- Config hash over fully resolved config (after `extends`) + prompt text.
- `store/schema.ts` is generated from `schema.sql` — keep in sync (test enforces).
- `docs/` = the documentation: plain Markdown that reads on GitHub (links between pages are `page.md#section`, callouts are `> [!NOTE]` / `> [!WARNING]`, order in `nav.json`). The website (separate private repository `codetiller-site`) renders these files. A changed command, flag or limit changes its docs page in the same commit.
- The repository root is not a working dir. What ships is under `defaults/`; a working dir (`tiller.yaml`, `tiller.db`, `.cache/`, `artifacts/`, its own `configs/` `prompts/` `skills/`) overrides it file by file.
- `packages/core/src/index.ts` lists what other packages may import, by name. Inside `core`, import by path; add a name to the index only when another package needs it.
