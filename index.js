import { Client, specTypeSchemas } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-lazy-mcp'
export const inject = ['tools']

const ServerConfig = z.object({
  command: z.string().required(),
  args: z.array(String).default([]),
  cwd: z.string().default(''),
  env: z.dict(String).default({}),
  projectArg: z.string().default(''),
})

export const Config = z.object({
  idleTimeoutMs: z.number().min(1000).default(300_000),
  connectTimeoutMs: z.number().min(1000).default(15_000),
  requestTimeoutMs: z.number().min(1000).default(180_000),
  servers: z.dict(ServerConfig).required(),
})

const jsonOutput = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

function textFromContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function validateServerName(serverNames, server) {
  if (!serverNames.includes(server)) {
    throw new Error(`Unknown lazy MCP server ${JSON.stringify(server)}; choose one of: ${serverNames.join(', ')}`)
  }
}

async function canonicalProject(requested, fallback) {
  const candidate = requested || fallback
  if (!candidate) throw new Error('project is required because this server has no default cwd')
  if (!path.isAbsolute(candidate)) throw new Error(`project must be an absolute path: ${JSON.stringify(candidate)}`)
  let canonical
  try {
    canonical = await realpath(candidate)
  } catch {
    throw new Error(`project must be an existing directory: ${JSON.stringify(candidate)}`)
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`project must be an existing directory: ${JSON.stringify(candidate)}`)
  }
  return canonical
}

function projectSpec(spec, project) {
  return {
    ...spec,
    cwd: project,
    args: spec.projectArg ? [...spec.args, spec.projectArg, project] : [...spec.args],
  }
}

export class LazyServer {
  constructor(name, spec, options, project = spec.cwd) {
    this.name = name
    this.project = project
    this.spec = spec
    this.options = options
    this.status = 'stopped'
    this.client = undefined
    this.transport = undefined
    this.startPromise = undefined
    this.stopPromise = undefined
    this.tools = undefined
    this.lastUsedAt = undefined
    this.lastError = undefined
    this.activeCalls = 0
    this.idleTimer = undefined
    this.generation = 0
    this.disposed = false
  }

  snapshot() {
    return {
      server: this.name,
      project: this.project,
      status: this.status,
      pid: this.transport?.pid ?? null,
      toolsCached: this.tools?.size ?? 0,
      activeCalls: this.activeCalls,
      lastUsedAt: this.lastUsedAt === undefined ? null : new Date(this.lastUsedAt).toISOString(),
      lastError: this.lastError ?? null,
    }
  }

  clearIdleTimer() {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  touch() {
    this.lastUsedAt = Date.now()
    this.scheduleIdleStop()
  }

  scheduleIdleStop() {
    this.clearIdleTimer()
    if (this.disposed || this.status !== 'ready' || this.activeCalls !== 0) return
    const generation = this.generation
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.disposed || generation !== this.generation || this.activeCalls !== 0 || this.status !== 'ready') return
      const idleFor = Date.now() - (this.lastUsedAt ?? 0)
      if (idleFor < this.options.idleTimeoutMs) {
        this.scheduleIdleStop()
        return
      }
      void this.stop('idle timeout')
    }, this.options.idleTimeoutMs)
    this.idleTimer.unref()
  }

  async start(signal) {
    if (this.disposed) throw new Error(`Lazy MCP server ${this.name} is disposed`)
    if (this.status === 'ready' && this.client !== undefined) {
      this.touch()
      return this.client
    }
    if (this.startPromise !== undefined) return await this.startPromise
    if (this.stopPromise !== undefined) await this.stopPromise

    const generation = ++this.generation
    this.status = 'starting'
    this.lastError = undefined
    const client = new Client(
      { name: `dsh-lazy-mcp-${this.name}`, version: '1.0.0' },
      { capabilities: {} },
    )
    const transport = new StdioClientTransport({
      command: this.spec.command,
      args: this.spec.args,
      cwd: this.spec.cwd || undefined,
      env: { ...scrubbedParentEnv(), ...this.spec.env },
      stderr: 'inherit',
    })
    client.onclose = () => {
      if (generation !== this.generation || this.status === 'stopping' || this.status === 'stopped') return
      this.clearIdleTimer()
      this.client = undefined
      this.transport = undefined
      this.tools = undefined
      this.status = 'stopped'
    }

    const opening = (async () => {
      try {
        await client.connect(transport, { signal, timeout: this.options.connectTimeoutMs })
        if (this.disposed || generation !== this.generation) {
          await client.close().catch(() => {})
          throw new Error(`Lazy MCP server ${this.name} start was superseded`)
        }
        this.client = client
        this.transport = transport
        this.status = 'ready'
        this.touch()
        return client
      } catch (error) {
        this.lastError = errorMessage(error)
        this.status = 'error'
        await client.close().catch(async () => { await transport.close().catch(() => {}) })
        if (generation === this.generation) {
          this.client = undefined
          this.transport = undefined
          this.tools = undefined
        }
        throw error
      } finally {
        if (this.startPromise === opening) this.startPromise = undefined
      }
    })()
    this.startPromise = opening
    return await opening
  }

  async withActivity(signal, operation) {
    const client = await this.start(signal)
    this.clearIdleTimer()
    this.activeCalls += 1
    try {
      const value = await operation(client)
      this.touch()
      return value
    } finally {
      this.activeCalls -= 1
      this.scheduleIdleStop()
    }
  }

  async listTools(signal, refresh = true) {
    return await this.withActivity(signal, async client => {
      if (!refresh && this.tools !== undefined) return [...this.tools.values()]
      const response = await client.listTools(undefined, {
        signal,
        timeout: this.options.requestTimeoutMs,
        cacheMode: 'refresh',
      })
      this.tools = new Map(response.tools.map(tool => [tool.name, tool]))
      return response.tools
    })
  }

  async callTool(rawName, args, signal) {
    return await this.withActivity(signal, async client => {
      if (this.tools === undefined || !this.tools.has(rawName)) {
        const response = await client.listTools(undefined, {
          signal,
          timeout: this.options.requestTimeoutMs,
          cacheMode: 'refresh',
        })
        this.tools = new Map(response.tools.map(tool => [tool.name, tool]))
      }
      const tool = this.tools.get(rawName)
      if (tool === undefined) {
        throw new Error(`MCP server ${this.name} does not advertise tool ${JSON.stringify(rawName)}`)
      }
      const raw = await client.callTool(
        { name: rawName, arguments: args },
        { signal, timeout: this.options.requestTimeoutMs, toolDefinition: tool },
      )
      const parsed = specTypeSchemas.CallToolResult['~standard'].validate(raw)
      if (parsed.issues !== undefined) {
        throw new Error(`MCP tool ${rawName} returned an invalid result: ${parsed.issues.map(issue => issue.message).join('; ')}`)
      }
      const result = parsed.value
      if (result.isError === true) throw new Error(textFromContent(result.content) || `MCP tool ${rawName} failed`)
      return result
    })
  }

  async stop(reason = 'explicit request') {
    if (this.stopPromise !== undefined) return await this.stopPromise
    if (this.status === 'stopped' && this.startPromise === undefined) return { server: this.name, stopped: false, reason: 'already stopped' }
    this.clearIdleTimer()
    const generation = ++this.generation
    this.status = 'stopping'
    const stopping = (async () => {
      await this.startPromise?.catch(() => {})
      const client = this.client
      const transport = this.transport
      this.client = undefined
      this.transport = undefined
      this.tools = undefined
      try {
        if (client !== undefined) await client.close()
        else if (transport !== undefined) await transport.close()
      } finally {
        if (generation === this.generation) this.status = 'stopped'
      }
      return { server: this.name, stopped: true, reason }
    })()
    this.stopPromise = stopping
    try {
      return await stopping
    } finally {
      if (this.stopPromise === stopping) this.stopPromise = undefined
    }
  }

  async dispose() {
    this.disposed = true
    await this.stop('plugin disposed')
  }
}

export function apply(ctx, config) {
  const serverNames = Object.keys(config.servers).sort()
  if (serverNames.length === 0) throw new Error('dsh-lazy-mcp requires at least one configured server')
  const common = {
    idleTimeoutMs: config.idleTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
  }
  const instances = new Map()
  const keyOf = (server, project) => `${server}\u0000${project}`
  const getServer = async (server, requestedProject, create = true) => {
    validateServerName(serverNames, server)
    const spec = config.servers[server]
    const project = await canonicalProject(requestedProject, spec.cwd)
    const key = keyOf(server, project)
    let instance = instances.get(key)
    if (instance === undefined && create) {
      instance = new LazyServer(server, projectSpec(spec, project), common, project)
      instances.set(key, instance)
    }
    return { instance, project }
  }
  const matchingInstances = async (server, requestedProject) => {
    if (server === undefined && requestedProject === undefined) return [...instances.values()]
    if (server === undefined) {
      const project = await canonicalProject(requestedProject, '')
      return [...instances.values()].filter(instance => instance.project === project)
    }
    validateServerName(serverNames, server)
    if (requestedProject === undefined) {
      return [...instances.values()].filter(instance => instance.name === server)
    }
    const { instance } = await getServer(server, requestedProject, false)
    return instance === undefined ? [] : [instance]
  }
  const disposers = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'lazy_mcp_status',
    description: 'Show whether each configured lazy MCP server is stopped, starting, ready, stopping, or failed. This never starts a server.',
    parameters: {
      server: { type: 'string', enum: serverNames, description: 'Optional server filter.' },
      project: { type: 'string', description: 'Optional absolute project path filter. This never creates an instance.' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args) {
      return { servers: (await matchingInstances(args.server, args.project)).map(server => server.snapshot()) }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'lazy_mcp_list_tools',
    description: 'Start one configured MCP server on demand and list its tools. Use before lazy_mcp_call_tool when the upstream tool name or argument schema is unknown.',
    parameters: {
      server: { type: 'string', required: true, enum: serverNames, description: 'Lazy MCP server to start and inspect.' },
      project: { type: 'string', description: 'Absolute project/workspace directory; defaults to the server cwd.' },
      refresh: { type: 'boolean', description: 'Refresh tools from the server; defaults to true.' },
    },
    output: jsonOutput,
    timeoutMs: Math.max(config.connectTimeoutMs, config.requestTimeoutMs),
    async execute(args, exec) {
      const { instance: server, project } = await getServer(args.server, args.project)
      const tools = await server.listTools(exec.signal, args.refresh !== false)
      return {
        server: args.server,
        project,
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema ?? null,
        })),
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'lazy_mcp_call_tool',
    description: 'Start a configured MCP server on demand and call one raw MCP tool. The tool name is checked against the server-advertised list before dispatch.',
    parameters: {
      server: { type: 'string', required: true, enum: serverNames, description: 'Configured lazy MCP server.' },
      project: { type: 'string', description: 'Absolute project/workspace directory; defaults to the server cwd.' },
      tool: { type: 'string', required: true, description: 'Raw tool name returned by lazy_mcp_list_tools.' },
      arguments: { type: 'object', required: true, additionalProperties: true, description: 'Arguments matching the upstream tool inputSchema.' },
    },
    output: jsonOutput,
    timeoutMs: Math.max(config.connectTimeoutMs, config.requestTimeoutMs),
    async execute(args, exec) {
      const { instance: server, project } = await getServer(args.server, args.project)
      const result = await server.callTool(args.tool, args.arguments, exec.signal)
      return { server: args.server, project, tool: args.tool, result }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'lazy_mcp_stop',
    description: 'Stop one lazy MCP server or all of them immediately. Normally servers stop automatically after the idle timeout.',
    parameters: {
      server: { type: 'string', enum: serverNames, description: 'Server to stop; omit to stop every running server.' },
      project: { type: 'string', description: 'Absolute project path to stop. Combine with server for one exact instance.' },
    },
    output: jsonOutput,
    async execute(args) {
      const targets = await matchingInstances(args.server, args.project)
      return { results: await Promise.all(targets.map(server => server.stop())) }
    },
  })))

  ctx.effect(() => async () => {
    for (const dispose of disposers.splice(0)) dispose()
    await Promise.allSettled([...instances.values()].map(server => server.dispose()))
  }, 'dsh-lazy-mcp.lifecycle')
}
