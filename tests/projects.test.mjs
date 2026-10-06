import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'

function facade(config) {
  const tools = new Map()
  const cleanups = []
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  apply(ctx, config)
  const signal = new AbortController().signal
  return {
    call(name, args = {}) {
      return tools.get(name).execute(args, { signal })
    },
    async dispose() {
      await Promise.allSettled(cleanups.map(cleanup => cleanup()))
    },
  }
}

const config = {
  idleTimeoutMs: 60_000,
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 15_000,
  servers: {
    'codebase-memory': {
      command: '/Users/hoaiminh/.local/bin/codebase-memory-mcp',
      args: [],
      cwd: '',
      env: {},
      projectArg: '',
    },
  },
}

test('facade isolates and reuses MCP instances by canonical project path', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-lazy-projects-'))
  const first = path.join(root, 'first')
  const second = path.join(root, 'second')
  await Promise.all([
    import('node:fs/promises').then(({ mkdir }) => mkdir(first)),
    import('node:fs/promises').then(({ mkdir }) => mkdir(second)),
  ])
  const bridge = facade(config)
  try {
    await bridge.call('lazy_mcp_list_tools', { server: 'codebase-memory', project: first, refresh: true })
    const firstStatus = await bridge.call('lazy_mcp_status', { server: 'codebase-memory', project: first })
    const firstPid = firstStatus.servers[0].pid
    assert.equal(firstStatus.servers[0].project, await realpath(first))
    assert.ok(firstPid > 0)

    await bridge.call('lazy_mcp_list_tools', { server: 'codebase-memory', project: `${first}/../first`, refresh: false })
    const reused = await bridge.call('lazy_mcp_status', { server: 'codebase-memory', project: first })
    assert.equal(reused.servers[0].pid, firstPid)

    await bridge.call('lazy_mcp_list_tools', { server: 'codebase-memory', project: second, refresh: true })
    const all = await bridge.call('lazy_mcp_status', {})
    assert.equal(all.servers.length, 2)
    assert.deepEqual(new Set(all.servers.map(row => row.project)), new Set([await realpath(first), await realpath(second)]))
    assert.equal(new Set(all.servers.map(row => row.pid)).size, 2)

    await bridge.call('lazy_mcp_stop', { server: 'codebase-memory', project: first })
    const afterStop = await bridge.call('lazy_mcp_status', {})
    const canonicalFirst = await realpath(first)
    const canonicalSecond = await realpath(second)
    assert.equal(afterStop.servers.find(row => row.project === canonicalFirst).status, 'stopped')
    assert.equal(afterStop.servers.find(row => row.project === canonicalSecond).status, 'ready')
  } finally {
    await bridge.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('facade rejects relative and missing project paths before spawn', async () => {
  const bridge = facade(config)
  try {
    await assert.rejects(
      bridge.call('lazy_mcp_list_tools', { server: 'codebase-memory', project: 'relative/project' }),
      /absolute path/,
    )
    await assert.rejects(
      bridge.call('lazy_mcp_list_tools', { server: 'codebase-memory', project: '/definitely/not/a/real/project' }),
      /existing directory/,
    )
    const status = await bridge.call('lazy_mcp_status', {})
    assert.deepEqual(status.servers, [])
  } finally {
    await bridge.dispose()
  }
})
