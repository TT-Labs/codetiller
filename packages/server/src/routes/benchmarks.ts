import { Hono } from 'hono'
import type { ServerContext } from '../context.js'

export const benchmarkRoutes = (ctx: ServerContext) =>
  new Hono()
    .get('/', (c) => c.json(ctx.store.listBenchmarks()))
    .get('/:id', (c) => {
      const benchmark = ctx.store.getBenchmark(c.req.param('id'))
      if (!benchmark) return c.json({ error: 'benchmark not found' }, 404)
      return c.json({ benchmark, runs: ctx.store.runsOf(benchmark.id) })
    })
