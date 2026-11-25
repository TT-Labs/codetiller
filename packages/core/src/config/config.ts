import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { sha256, stableStringify } from '../util/hash.js'

export const LimitsSchema = z.object({
  max_turns: z.number().int().positive(),
  timeout_s: z.number().positive(),
  budget_usd: z.number().positive(),
})

const RawConfigSchema = z.object({
  name: z.string(),
  extends: z.string().optional(),
  harness: z.enum(['claude-code', 'codex']).optional(),
  model: z.string().optional(),
  skills: z.array(z.string()).optional(),
  prompt_template: z.string().optional(),
  limits: LimitsSchema.partial().optional(),
})

export const ConfigSchema = z.object({
  name: z.string(),
  harness: z.enum(['claude-code', 'codex']),
  model: z.string(),
  skills: z.array(z.string()),
  prompt_template: z.string(),
  limits: LimitsSchema,
})

export type RawConfig = z.infer<typeof RawConfigSchema>
export type Config = z.infer<typeof ConfigSchema>

/** Merge child over parent; `extends` resolved before hashing. */
export function mergeConfig(parent: RawConfig, child: RawConfig): RawConfig {
  return {
    ...parent,
    ...child,
    extends: undefined,
    limits: { ...parent.limits, ...child.limits },
  }
}

/** Load configs/<name>.yaml, resolving `extends` chain from the same dir. */
export async function loadConfig(path: string, seen = new Set<string>()): Promise<Config> {
  return ConfigSchema.parse(await loadRaw(path, seen))
}

async function loadRaw(path: string, seen: Set<string>): Promise<RawConfig> {
  if (seen.has(path)) throw new Error(`config extends cycle at ${path}`)
  seen.add(path)
  const raw = RawConfigSchema.parse(parse(await readFile(path, 'utf8')))
  if (!raw.extends) return raw
  const parent = await loadRaw(join(dirname(path), `${raw.extends}.yaml`), seen)
  return mergeConfig(parent, raw)
}

/** Content hash over resolved config + prompt template text. `name` excluded. */
export function configHash(config: Config, promptTemplate: string, skillsText = ''): string {
  const { name: _name, ...rest } = config
  const skills_hash = skillsText ? sha256(skillsText) : undefined
  return sha256(
    stableStringify({ ...rest, prompt_template: sha256(promptTemplate), skills_hash }),
  ).slice(0, 16)
}
