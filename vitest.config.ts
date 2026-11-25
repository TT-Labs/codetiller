import { defineConfig } from 'vitest/config'

// `source` condition: workspace packages resolve to src/, not a stale dist/
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: { include: ['packages/*/src/**/*.test.ts'] },
})
