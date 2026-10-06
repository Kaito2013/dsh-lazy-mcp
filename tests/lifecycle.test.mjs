import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LazyServer } from '../index.js'

const baseSpec = {
  command: '/Users/hoaiminh/.local/bin/codebase-memory-mcp',
  args: [],
  cwd: '/Users/hoaiminh/Sites/localhost/tingnect',
  env: {},
}

const options = {
  idleTimeoutMs: 60_000,
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 15_000,
}

test('does not spawn before first operation, then lists, calls and stops', { timeout: 30_000 }, async () => {
  const server = new LazyServer('codebase-memory', baseSpec, options)
  assert.equal(server.snapshot().status, 'stopped')
  assert.equal(server.snapshot().pid, null)

  const tools = await server.listTools(undefined, true)
  assert.equal(server.snapshot().status, 'ready')
  assert.ok(server.snapshot().pid > 0)
  assert.ok(tools.some(tool => tool.name === 'list_projects'))

  const result = await server.callTool('list_projects', {}, undefined)
  assert.equal(result.isError, undefined)
  assert.ok(Array.isArray(result.content))

  const pid = server.snapshot().pid
  const stopped = await server.stop('test complete')
  assert.equal(stopped.stopped, true)
  assert.equal(server.snapshot().status, 'stopped')
  assert.equal(server.snapshot().pid, null)
  assert.throws(() => process.kill(pid, 0))
})

test('concurrent first starts share one subprocess', { timeout: 30_000 }, async () => {
  const server = new LazyServer('codebase-memory', baseSpec, options)
  const [a, b] = await Promise.all([
    server.listTools(undefined, true),
    server.listTools(undefined, false),
  ])
  assert.ok(a.length > 0)
  assert.ok(b.length > 0)
  assert.equal(server.snapshot().status, 'ready')
  await server.dispose()
})

test('unknown tool is rejected after discovery', { timeout: 30_000 }, async () => {
  const server = new LazyServer('codebase-memory', baseSpec, options)
  await assert.rejects(() => server.callTool('not_a_real_tool', {}, undefined), /does not advertise tool/)
  await server.dispose()
})

test('idle timeout reaps a started subprocess', { timeout: 10_000 }, async () => {
  const server = new LazyServer('codebase-memory', baseSpec, { ...options, idleTimeoutMs: 100 })
  await server.listTools(undefined, true)
  const pid = server.snapshot().pid
  assert.ok(pid > 0)
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(server.snapshot().status, 'stopped')
  assert.throws(() => process.kill(pid, 0))
})

test('Serena starts only on demand and exposes semantic tools', { timeout: 30_000 }, async () => {
  const server = new LazyServer('serena', {
    command: '/Users/hoaiminh/.local/bin/serena',
    args: ['start-mcp-server', '--context', 'claude-code', '--project', '/Users/hoaiminh/Sites/localhost/tingnect'],
    cwd: '/Users/hoaiminh/Sites/localhost/tingnect',
    env: {},
  }, options)
  assert.equal(server.snapshot().pid, null)
  const tools = await server.listTools(undefined, true)
  assert.ok(tools.some(tool => tool.name === 'find_symbol'))
  assert.equal(server.snapshot().status, 'ready')
  await server.dispose()
})
