#!/usr/bin/env node
import './dotenv.js'

import { Command } from 'commander'
import { register as evals } from './commands/evals.js'
import { register as factory } from './commands/factory.js'
import { register as ops } from './commands/ops.js'

const program = new Command('tiller')
  .description('codetiller — coding agent factory')
  .version(process.env.TILLER_VERSION || 'dev')

evals(program)
ops(program)
factory(program)

await program.parseAsync()
