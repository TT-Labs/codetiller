import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ClaudeCodeAdapter, OFFLINE_PRELUDE } from '../agents/claude-code.js'
import type { Config } from '../config/config.js'
import type { ModelAccess } from './gateway.js'
import type { ExecRequest, Sandbox } from './sandbox.js'

/**
 * The trust boundary, measured. Each probe runs inside a container configured
 * exactly as the factory configures it and reports one fact; no model call, no cost.
 */
export interface ProbeResult {
  /** which container: the agent's, the dependency install's, the verification's */
  container: 'agent' | 'deps install' | 'verification'
  probe: string
  /** what the boundary requires */
  want: string
  observed: string
  /** `open` = a known gap the factory accepts for now (reported, does not fail the audit) */
  status: 'ok' | 'FAIL' | 'open'
}

// prints `name=value` lines; never prints a secret, only whether one is there
const SCRIPT = String.raw`
p() { printf '%s=%s\n' "$1" "$2"; }
code() { curl -sS -m "$2" -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }
via() { curl -sS -m 8 -o /dev/null -w '%{http_code}' -x "$ANTHROPIC_BASE_URL" "$1" 2>/dev/null || true; }
p egress_https "$(code https://example.com 8)"
p egress_ip "$(code http://1.1.1.1 8)"
p dns "$(getent hosts example.com >/dev/null 2>&1 && echo resolved || echo none)"
# the factory's API from here: by docker's name for the host, by the gateway address of each
# network this container is on (the docker host itself, on Linux), and by every address the
# factory process has. The first one that answers anything is reported.
host_api() {
  for h in host.docker.internal $TILLER_AUDIT_HOSTS $(hostname -i 2>/dev/null | tr ' ' '\n' | sed -n 's/^\([0-9]*\.[0-9]*\.[0-9]*\)\.[0-9]*$/\1.1/p'); do
    c="$(code "http://$h:$TILLER_AUDIT_PORT/api/health" 4)"
    case "$c" in 000|'') ;; *) echo "$c"; return ;; esac
  done
  echo 000
}
p host_api "$(host_api)"
# Kubernetes: no credential of the cluster in the pod, and its API out of reach
p kube_token "$([ -e /var/run/secrets/kubernetes.io/serviceaccount/token ] && echo present || echo absent)"
if [ -n "$TILLER_AUDIT_KUBE" ]; then p kube_api "$(curl -sSk -m 4 -o /dev/null -w '%{http_code}' "https://$TILLER_AUDIT_KUBE/version" 2>/dev/null || true)"; else p kube_api n/a; fi
model="$ANTHROPIC_BASE_URL"; [ -n "$model" ] || model=https://api.anthropic.com
p model_api "$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -H "x-api-key: $ANTHROPIC_API_KEY" -H 'anthropic-version: 2023-06-01' "$model/v1/models" 2>/dev/null || true)"
case "$ANTHROPIC_API_KEY" in sk-ant-*) p model_key present ;; *) p model_key absent ;; esac
p secret_env "$(env | cut -d= -f1 | grep -iE 'token|secret|password|github|^gh_' | tr '\n' ' ')"
if [ -n "$ANTHROPIC_BASE_URL" ]; then
  p gateway_proxy "$(via http://example.com/)"
  p gateway_tunnel "$(via https://example.com/)"
  p gateway_path "$(code "$ANTHROPIC_BASE_URL/" 6)"
  # asked only of the gateway: against the real API this would be a paid call
  post() { curl -sS -m 8 -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "x-api-key: $3" -d "$2" "$ANTHROPIC_BASE_URL$1" 2>/dev/null || true; }
  run="$ANTHROPIC_API_KEY"
  p gateway_server_tool "$(post /v1/messages '{"model":"x","max_tokens":1,"messages":[],"tools":[{"type":"web_fetch_20250910","name":"web_fetch"}]}' "$run")"
  p gateway_endpoint "$(post /v1/messages/batches '{"requests":[]}' "$run")"
  # every refusal below comes before anything is forwarded: none of these is a paid call
  p gateway_no_run "$(post /v1/messages '{"model":"x","max_tokens":1,"messages":[]}' tiller-run-not-an-open-run)"
  p gateway_model "$(post /v1/messages '{"model":"claude-not-the-model-of-this-run","max_tokens":1,"messages":[]}' "$run")"
  p gateway_admin "$(post /admin/runs '{"token":"tiller-run-opened-by-the-agent-itself","budget_usd":1000,"models":["x"],"prices":{}}' "$run")"
else
  p gateway_proxy n/a; p gateway_tunnel n/a; p gateway_path n/a
  p gateway_server_tool n/a; p gateway_endpoint n/a
  p gateway_no_run n/a; p gateway_model n/a; p gateway_admin n/a
fi
# the registry proxy an install is given: reads pass, nothing else does
if [ -n "$npm_config_registry" ]; then
  reg="$(printf %s "$npm_config_registry" | sed 's|/npm/$||')"
  p registry_read "$(code "$npm_config_registry"left-pad 20)"
  p registry_write "$(curl -sS -m 8 -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' -d '{"name":"probe"}' "$npm_config_registry"tiller-probe 2>/dev/null || true)"
  p registry_other "$(code "$reg/other/x" 8)"
  p registry_proxy "$(curl -sS -m 8 -o /dev/null -w '%{http_code}' -x "$reg" http://example.com/ 2>/dev/null || true)"
else
  p registry_read n/a; p registry_write n/a; p registry_other n/a; p registry_proxy n/a
fi
# a repo that pins another pnpm version: the call must not wait for a download that cannot happen
if command -v pnpm >/dev/null 2>&1 && [ -f /workspace/package.json ]; then
  s=$(date +%s); (cd /workspace && pnpm --version >/dev/null 2>&1); p pnpm_wait "$(( $(date +%s) - s ))"
else
  p pnpm_wait 0
fi
p uid "$(id -u)"
p caps "$(awk '/CapBnd/ {print $2}' /proc/self/status)"
p no_new_privs "$(awk '/NoNewPrivs/ {print $2}' /proc/self/status)"
p docker_socket "$([ -e /var/run/docker.sock ] && echo present || echo absent)"
p write_system "$(touch /etc/tiller-probe 2>/dev/null && echo writable || echo denied)"
p write_prompt "$( [ -e /tiller/prompt.md ] && { touch /tiller/prompt.md 2>/dev/null && echo writable || echo denied; } || echo n/a)"
p write_workspace "$(touch /workspace/.tiller-probe 2>/dev/null && rm -f /workspace/.tiller-probe && echo writable || echo denied)"
`

type Rule = [probe: string, want: string, ok: (v: string) => boolean]

const blocked = (v: string) => v === '000' || v === ''
const BASE: Rule[] = [
  ['uid', 'not root', (v) => v !== '0' && v !== ''],
  ['caps', 'no capabilities', (v) => /^0+$/.test(v)],
  ['no_new_privs', 'cannot gain privileges', (v) => v === '1'],
  ['docker_socket', 'absent', (v) => v === 'absent'],
  ['write_system', 'denied', (v) => v === 'denied'],
  ['secret_env', 'no token or secret in the environment', (v) => v.trim() === ''],
  ['kube_token', 'no service account token of the cluster', (v) => v === 'absent'],
  ['kube_api', 'cannot reach the Kubernetes API', (v) => blocked(v) || v === 'n/a'],
]
const CLOSED: Rule[] = [
  ['egress_https', 'no route to the internet', blocked],
  ['egress_ip', 'no route to the internet by IP', blocked],
  ['dns', 'no outside DNS (exfiltration channel)', (v) => v === 'none'],
  ['host_api', 'cannot reach the factory API on the host', blocked],
]

const RULES: Record<ProbeResult['container'], Rule[]> = {
  agent: [
    ...CLOSED,
    ['model_api', 'model API reachable (HTTP 200)', (v) => v === '200'],
    ['model_key', 'agent holds no model key', (v) => v === 'absent'],
    ['gateway_proxy', 'gateway refuses to proxy other hosts', (v) => v === '403' || v === 'n/a'],
    ['gateway_tunnel', 'gateway refuses CONNECT tunnels', (v) => v !== '200' && v !== ''],
    ['gateway_path', 'gateway serves the model API only', (v) => v === '403' || v === 'n/a'],
    [
      'gateway_server_tool',
      'gateway refuses server-side web tools (a way out through the model API)',
      (v) => v === '403' || v === 'n/a',
    ],
    [
      'gateway_endpoint',
      'gateway refuses batches, files, admin',
      (v) => v === '403' || v === 'n/a',
    ],
    [
      'gateway_no_run',
      'gateway serves no key that is not an open run',
      (v) => v === '401' || v === 'n/a',
    ],
    [
      'gateway_model',
      'gateway forwards only the model of the run',
      (v) => v === '403' || v === 'n/a',
    ],
    [
      'gateway_admin',
      'an agent cannot open a run or raise a budget',
      (v) => v === '403' || v === 'n/a',
    ],
    [
      'pnpm_wait',
      'package manager answers in under 5 s offline',
      (v) => /^\d+$/.test(v) && Number(v) < 5,
    ],
    ['write_prompt', 'prompt is read-only', (v) => v === 'denied'],
    ['write_workspace', "workspace writable (it is the agent's job)", (v) => v === 'writable'],
    ...BASE,
  ],
  verification: [...CLOSED, ['model_key', 'no model key', (v) => v === 'absent'], ...BASE],
  // an install runs code the agent chose: it may read the registries and reach nothing else
  'deps install': [
    ['egress_https', 'no route to the internet', blocked],
    ['egress_ip', 'no route to the internet by IP', blocked],
    ['dns', 'no outside DNS (exfiltration channel)', (v) => v === 'none'],
    // on the open network (no proxy) the port is reachable: then it must answer nothing
    [
      'host_api',
      'factory API on the host unreachable, or refuses it (no token, foreign host)',
      (v) => blocked(v) || v === '401' || v === '403',
    ],
    ['registry_read', 'package registry readable through the proxy (HTTP 200)', (v) => v === '200'],
    [
      'registry_write',
      'registry proxy refuses writes (publishing is a way out)',
      (v) => v === '405',
    ],
    ['registry_other', 'registry proxy serves the configured registries only', (v) => v === '404'],
    ['registry_proxy', 'registry proxy refuses to proxy other hosts', (v) => v === '404'],
    ['model_key', 'no model key', (v) => v === 'absent'],
    ...BASE,
  ],
}

/**
 * Probes whose failure is a known, accepted gap of that container. None now; without a registry
 * proxy (TILLER_EGRESS=direct) the install's open network fails the audit, as it should.
 */
const OPEN = new Set<string>()

const parse = (stdout: string) =>
  new Map(
    stdout
      .split('\n')
      .map((l) => /^([a-z_]+)=(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1] as string, (m[2] as string).trim()]),
  )

export function judgeProbes(container: ProbeResult['container'], stdout: string): ProbeResult[] {
  const seen = parse(stdout)
  return RULES[container].map(([probe, want, ok]) => {
    const observed = seen.get(probe)
    // a probe that did not report proves nothing: that is a failure, never a pass
    if (observed === undefined)
      return { container, probe, want, observed: 'no result', status: 'FAIL' as const }
    const key = `${container}:${probe}`
    // an open-network container reaching the internet is expected; say what that exposes
    const exposed = OPEN.has(key) && (probe === 'egress_https' ? !blocked(observed) : !ok(observed))
    return {
      container,
      probe,
      want,
      observed: observed || '(none)',
      status: exposed ? 'open' : ok(observed) ? 'ok' : 'FAIL',
    }
  })
}

/**
 * Run the probes in the three kinds of container the factory starts for a task. `access` is what
 * the factory would hand an agent (gateway or direct key); `port` is where the factory UI/API
 * listens, on the host or in the factory's own container.
 */
export async function auditSandbox(input: {
  sandbox: Sandbox
  image: string
  config: Config
  access: ModelAccess
  port: number
  /** addresses of the factory process itself (its container's, or the machine's) */
  hosts?: string[]
  /** `host:port` of the Kubernetes API when the factory runs in a cluster */
  kubeApi?: string
  /** where task workspaces live: the probe workspace sits next to them, mounted the same way */
  workDir: string
}): Promise<ProbeResult[]> {
  const { sandbox, image, config, access, port } = input
  await mkdir(input.workDir, { recursive: true })
  const dir = await mkdtemp(join(input.workDir, 'audit-'))
  const promptFile = join(dir, 'prompt.md')
  await writeFile(promptFile, 'audit')
  // a version no image ships: the case where pnpm goes to the network
  await writeFile(
    join(dir, 'package.json'),
    '{ "name": "audit", "packageManager": "pnpm@9.0.0" }\n',
  )
  const probe = { cmd: ['sh', '-c', SCRIPT], limits: { timeout_s: 240 }, onStdout: undefined }
  const install = await sandbox.installAccess?.()
  const env = {
    TILLER_AUDIT_PORT: String(port),
    // addresses only: anything else would be a way to put words into the probe's shell
    TILLER_AUDIT_HOSTS: (input.hosts ?? []).filter((h) => /^[0-9.]+$/.test(h)).join(' '),
    TILLER_AUDIT_KUBE: /^[0-9.]+:\d+$/.test(input.kubeApi ?? '') ? (input.kubeApi as string) : '',
  }
  // the agent's container exactly as the adapter builds it, with the probe as its command
  const agent = new ClaudeCodeAdapter().request({
    sandbox,
    image,
    workspace: dir,
    promptFile,
    config,
    env: access.env,
    network: access.network,
    offline: access.offline,
  })
  // the agent's start-up lines run before the probe, as they run before the agent
  const agentProbe = {
    ...probe,
    cmd: ['sh', '-c', `${access.offline ? `${OFFLINE_PRELUDE}\n` : ''}${SCRIPT}`],
  }
  const base: ExecRequest = { image, mounts: [{ host: dir, container: '/workspace' }], ...probe }
  const runs: [ProbeResult['container'], ExecRequest][] = [
    ['agent', { ...agent, ...agentProbe, env: { ...agent.env, ...env } }],
    // as sandbox/deps.ts starts the install: the registry proxy's network and settings, no credentials
    [
      'deps install',
      {
        ...base,
        workdir: '/workspace',
        network: install?.network,
        env: { ...install?.env, ...env },
      },
    ],
    // as verification runs the tests: no network
    ['verification', { ...base, network: 'none', env }],
  ]
  try {
    const results = await Promise.all(
      runs.map(async ([container, req]) =>
        judgeProbes(container, (await sandbox.exec(req)).stdout),
      ),
    )
    return results.flat()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
