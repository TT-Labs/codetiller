import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from '../config/config.js'
import type { ResolvedSkill } from '../context/resolve.js'
import { sha256 } from '../util/hash.js'

/**
 * What one run was made of. Written before the agent starts (inputs) and completed
 * when it ends (result), so a run that crashed still says what it ran on. Everything here is
 * either a content hash or an id that resolves to content: enough to rebuild the run's inputs.
 */
export interface RunManifest {
  schema: 1
  run: {
    id: string
    kind: 'run' | 'preflight' | 'review'
    seq: number | null
    started_at: string
  }
  task: { id: string; title: string; source: string; external_url: string | null }
  repo: {
    name: string
    branch: string
    /** commit the task branched from; repository skills are read at this commit */
    base_commit: string
    /** branch head the agent started from */
    head_before: string
  }
  /** the codetiller checkout that ran it; `dirty` = uncommitted changes, so the commit is not the whole story */
  factory: { version: string; commit: string | null; dirty: boolean }
  agent: {
    harness: Config['harness']
    model: string
    config: string
    /** hash over the resolved config, prompt template and rendered skills */
    config_id: string
    limits: Config['limits']
    /** follow-up runs continue the agent's session; its earlier turns are part of the input */
    resumed_session: string | null
  }
  sandbox: {
    image: string
    /** image content id at run time; null when the sandbox cannot say */
    image_id: string | null
    workspace: 'read-write' | 'read-only'
    /** docker network of the agent container: the gateway's internal one, or `bridge` (open) */
    network: string
    /** `gateway` = the agent held no credential; `direct` = it had the model key in its env */
    model_access: 'gateway' | 'direct'
    disallowed_tools: string[]
  }
  prompt: { template: string; sha256: string }
  skills: Pick<ResolvedSkill, 'name' | 'source' | 'ref' | 'sha256' | 'tokens'>[]
  /** hash of the context file as the agent saw it (repo's own + skills); null = none written */
  context_sha256: string | null
  /** ids of the human messages this run's prompt carried */
  human_messages: number[]
  result?: {
    exit: string
    signal: string | null
    cost_usd: number | null
    /** `gateway` = counted by the model gateway from the API's answers; `reported` = the agent's figure */
    cost_source?: string
    /** the agent's own figure, when the gateway's count is the one above */
    agent_cost_usd?: number | null
    /** the gateway's count of the run's model calls */
    gateway?: {
      requests: number
      refused: number
      tokens: { input: number; output: number; cache_read: number; cache_write: number }
    }
    turns: number | null
    duration_s: number | null
    /** commit the factory made from the agent's changes; null = nothing changed */
    commit: string | null
    verification: string | null
  }
}

export const MANIFEST_FILE = 'manifest.json'

export async function writeManifest(dir: string, manifest: RunManifest) {
  await writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
}

export async function readManifest(dir: string): Promise<RunManifest> {
  return JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8')) as RunManifest
}

export interface ManifestCheck {
  what: string
  ok: boolean
  detail: string
}

/** What a check needs from the outside: each returns the current content, or null when it is gone. */
export interface ManifestSources {
  /** is the commit still in the repo cache */
  hasCommit(repo: string, commit: string): Promise<boolean>
  /** current body of a factory skill (`name@N`) */
  factorySkill(ref: string): Promise<string | null>
  /** body of a repository skill at the manifest's base commit */
  repoSkill(repo: string, commit: string, path: string): Promise<string | null>
  /** current content id of the image */
  imageId(image: string): Promise<string | null>
  /** the prompt the run stored */
  prompt(): Promise<string | null>
}

/**
 * Can this run's inputs still be rebuilt, and are they what they were? Drift is reported per
 * input: a rebuilt image or an edited skill file does not make the manifest wrong, it makes a
 * rerun different.
 */
export async function checkManifest(
  m: RunManifest,
  src: ManifestSources,
): Promise<ManifestCheck[]> {
  const out: ManifestCheck[] = []
  const add = (what: string, ok: boolean, detail: string) => out.push({ what, ok, detail })
  for (const [label, commit] of [
    ['base commit', m.repo.base_commit],
    ['head before the run', m.repo.head_before],
  ] as const) {
    const has = await src.hasCommit(m.repo.name, commit)
    add(
      label,
      has,
      `${commit.slice(0, 12)} ${has ? 'is in the repo cache' : 'is missing from the repo cache'}`,
    )
  }
  for (const s of m.skills) {
    const body =
      s.source === 'repo'
        ? await src.repoSkill(m.repo.name, m.repo.base_commit, s.ref)
        : await src.factorySkill(s.ref)
    const ok = body !== null && sha256(body) === s.sha256
    add(
      `skill ${s.name} (${s.source})`,
      ok,
      body === null
        ? `${s.ref} not found`
        : ok
          ? `${s.ref} unchanged`
          : `${s.ref} changed since the run`,
    )
  }
  const image = await src.imageId(m.sandbox.image)
  if (m.sandbox.image_id === null)
    add('image', false, `${m.sandbox.image}: no content id was recorded`)
  else
    add(
      'image',
      image === m.sandbox.image_id,
      image === null
        ? `${m.sandbox.image} is not present`
        : image === m.sandbox.image_id
          ? `${m.sandbox.image} unchanged`
          : `${m.sandbox.image} was rebuilt since the run`,
    )
  const prompt = await src.prompt()
  const same = prompt !== null && sha256(prompt) === m.prompt.sha256
  add(
    'prompt',
    same,
    prompt === null
      ? 'stored prompt is missing'
      : same
        ? 'stored prompt matches'
        : 'stored prompt differs',
  )
  if (m.factory.dirty)
    add(
      'factory',
      false,
      `ran from ${m.factory.commit?.slice(0, 12) ?? 'an unknown commit'} with uncommitted changes`,
    )
  else
    add(
      'factory',
      m.factory.commit !== null,
      m.factory.commit ? `commit ${m.factory.commit.slice(0, 12)}` : 'commit unknown',
    )
  return out
}
