import { z } from 'zod'

const Rates = {
  input: z.number().positive(),
  output: z.number().positive(),
  cache_read: z.number().positive(),
  cache_write_5m: z.number().positive(),
  cache_write_1h: z.number().positive(),
}

/** USD per 1M tokens. `long`: the rates of a request whose prompt is over `over` tokens. */
export const ModelPriceSchema = z.object({
  ...Rates,
  long: z.object({ over: z.number().int().positive(), ...Rates }).optional(),
})
export type ModelPrice = z.infer<typeof ModelPriceSchema>

/** tiller.yaml `prices`: per model id, replaces the built-in entry */
export const PricesSchema = z.record(z.string(), ModelPriceSchema)
export type Prices = z.infer<typeof PricesSchema>

/** cache writes are 1.25× (5 min) and 2× (1 h) of input on every model; reads differ */
const p = (input: number, output: number, cache_read: number) => ({
  input,
  output,
  cache_read,
  cache_write_5m: input * 1.25,
  cache_write_1h: input * 2,
})

/**
 * List prices of the model API, https://platform.claude.com/docs/en/about-claude/pricing as of
 * 2026-11-16. The gateway counts a run's spend with these, so a model without an entry cannot
 * run behind it: add or correct entries under `prices` in tiller.yaml.
 */
export const PRICES: Prices = {
  'claude-fable-5-2': p(8, 40, 0.2),
  'claude-fable-5-1': p(10, 50, 0.25),
  'claude-fable-5': p(10, 50, 1),
  'claude-opus-5-5': p(4, 20, 0.2),
  'claude-opus-5': p(5, 25, 0.5),
  'claude-opus-4-8': p(5, 25, 0.5),
  'claude-sonnet-5-5': p(2, 10, 0.1),
  'claude-sonnet-5': p(2, 10, 0.2),
  'claude-sonnet-4-6': p(3, 15, 0.3),
  'claude-haiku-5-5': { ...p(0.1, 0.5, 0.01), long: { over: 100_000, ...p(0.5, 2.5, 0.05) } },
  'claude-haiku-4-5': p(1, 5, 0.1),
}

/** The entry for a model id: its own, or the one it is a dated snapshot of (as the gateway does). */
export function priceFor(model: string, prices: Prices = PRICES): ModelPrice | undefined {
  if (Object.hasOwn(prices, model)) return prices[model]
  const dated = /^(.+)-\d{8}$/.exec(model)
  return dated?.[1] && Object.hasOwn(prices, dated[1]) ? prices[dated[1]] : undefined
}
