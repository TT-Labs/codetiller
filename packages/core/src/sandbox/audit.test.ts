import { expect, it } from 'vitest'
import { judgeProbes } from './audit.js'

const out = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

const CLOSED = {
  egress_https: '000',
  egress_ip: '000',
  dns: 'none',
  host_api: '000',
  uid: '1000',
  caps: '0000000000000000',
  no_new_privs: '1',
  docker_socket: 'absent',
  write_system: 'denied',
  secret_env: '',
  kube_token: 'absent',
  kube_api: 'n/a',
}
const AGENT = {
  ...CLOSED,
  model_api: '200',
  model_key: 'absent',
  gateway_proxy: '403',
  gateway_tunnel: '000',
  gateway_path: '403',
  gateway_server_tool: '403',
  gateway_endpoint: '403',
  gateway_no_run: '401',
  gateway_model: '403',
  gateway_admin: '403',
  pnpm_wait: '0',
  write_prompt: 'denied',
  write_workspace: 'writable',
}

const failed = (rs: ReturnType<typeof judgeProbes>) =>
  rs.filter((r) => r.status === 'FAIL').map((r) => r.probe)

it('an agent behind the gateway passes every probe', () => {
  const rs = judgeProbes('agent', out(AGENT))
  expect(failed(rs)).toEqual([])
  expect(rs).toHaveLength(25)
})

it('fails each breach of the agent boundary by name', () => {
  // the state before the gateway: open network, key in the environment, factory API reachable
  const before = {
    ...AGENT,
    egress_https: '200',
    egress_ip: '301',
    dns: 'resolved',
    host_api: '200',
    model_key: 'present',
  }
  expect(failed(judgeProbes('agent', out(before)))).toEqual([
    'egress_https',
    'egress_ip',
    'dns',
    'host_api',
    'model_key',
  ])
  expect(failed(judgeProbes('agent', out({ ...AGENT, gateway_proxy: '200' })))).toEqual([
    'gateway_proxy',
  ])
  expect(failed(judgeProbes('agent', out({ ...AGENT, gateway_server_tool: '200' })))).toEqual([
    'gateway_server_tool',
  ])
  // a gateway that serves any key, any model, or lets the agent open its own run
  expect(
    failed(
      judgeProbes(
        'agent',
        out({ ...AGENT, gateway_no_run: '400', gateway_model: '400', gateway_admin: '200' }),
      ),
    ),
  ).toEqual(['gateway_no_run', 'gateway_model', 'gateway_admin'])
  expect(
    failed(judgeProbes('agent', out({ ...AGENT, secret_env: 'TILLER_GITHUB_TOKEN ' }))),
  ).toEqual(['secret_env'])
  expect(
    failed(
      judgeProbes(
        'agent',
        out({ ...AGENT, uid: '0', caps: '00000000a80425fb', no_new_privs: '0' }),
      ),
    ),
  ).toEqual(['uid', 'caps', 'no_new_privs'])
  // a package manager that waits for a network that is not there costs every run a minute
  expect(failed(judgeProbes('agent', out({ ...AGENT, pnpm_wait: '70' })))).toEqual(['pnpm_wait'])
  // an agent that cannot reach the model is not a working boundary either
  expect(failed(judgeProbes('agent', out({ ...AGENT, model_api: '000' })))).toEqual(['model_api'])
  // a probe that did not report counts as failed, not as passed
  expect(failed(judgeProbes('agent', ''))).toHaveLength(25)
})

const INSTALL = {
  ...CLOSED,
  model_key: 'absent',
  registry_read: '200',
  registry_write: '405',
  registry_other: '404',
  registry_proxy: '404',
}

it('a dependency install reads the registries through the proxy and reaches nothing else', () => {
  const rs = judgeProbes('deps install', out(INSTALL))
  expect(failed(rs)).toEqual([])
  expect(rs.filter((r) => r.status === 'open')).toEqual([])
  // the open network of before: every way out is a failure now, not an accepted gap
  expect(
    failed(
      judgeProbes(
        'deps install',
        out({
          ...INSTALL,
          egress_https: '200',
          egress_ip: '301',
          dns: 'resolved',
          host_api: '200',
          registry_read: 'n/a',
          registry_write: 'n/a',
          registry_other: 'n/a',
          registry_proxy: 'n/a',
        }),
      ),
    ),
  ).toEqual([
    'egress_https',
    'egress_ip',
    'dns',
    'host_api',
    'registry_read',
    'registry_write',
    'registry_other',
    'registry_proxy',
  ])
  // a proxy that takes a write or forwards elsewhere
  expect(
    failed(
      judgeProbes(
        'deps install',
        out({ ...INSTALL, registry_write: '200', registry_proxy: '200' }),
      ),
    ),
  ).toEqual(['registry_write', 'registry_proxy'])
  // a credential in that container is a failure
  expect(failed(judgeProbes('deps install', out({ ...INSTALL, model_key: 'present' })))).toEqual([
    'model_key',
  ])
})

it('verification must be closed', () => {
  expect(failed(judgeProbes('verification', out({ ...CLOSED, model_key: 'absent' })))).toEqual([])
  expect(
    failed(
      judgeProbes('verification', out({ ...CLOSED, model_key: 'absent', egress_https: '200' })),
    ),
  ).toEqual(['egress_https'])
})
