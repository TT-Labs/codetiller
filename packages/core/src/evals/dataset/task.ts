import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { z } from 'zod'
import { sha256 } from '../../util/hash.js'

export const TaskSchema = z.object({
  id: z.string(),
  repo: z.string(),
  base_commit: z.string(),
  fix_commit: z.string(),
  issue: z.object({ title: z.string(), body: z.string(), url: z.string().optional() }),
  hidden_tests: z.array(z.string()).min(1),
  fail_to_pass: z.array(z.string()).min(1),
  pass_to_pass: z.union([z.literal('suite'), z.array(z.string())]),
  tags: z.array(z.string()).default([]),
  difficulty: z.enum(['small', 'medium', 'large']).optional(),
  created_at: z.string().optional(),
})

export type Task = z.infer<typeof TaskSchema> & { spec_hash: string }

export async function loadTask(path: string): Promise<Task> {
  const raw = await readFile(path, 'utf8')
  return { ...TaskSchema.parse(parse(raw)), spec_hash: sha256(raw) }
}
