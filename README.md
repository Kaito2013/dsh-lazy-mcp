# dsh-lazy-mcp

Lazy, project-aware MCP bridge for DeepSeek Harness. It registers four lightweight facade tools at DSH startup and does **not** spawn an MCP subprocess until a facade tool actually needs it.

## Tools

- `lazy_mcp_status` — inspect instances without starting anything; filter by server/project.
- `lazy_mcp_list_tools` — start one server for one project and fetch its tools.
- `lazy_mcp_call_tool` — validate a raw name and call it in one project.
- `lazy_mcp_stop` — stop one project instance, all instances for a server, or everything.

Connections are cached by `(server, canonical project path)` and stopped after the configured idle timeout (default 5 minutes). Multiple workspaces can be active simultaneously without sharing MCP state. Plugin unload closes every child process.

## Calling a project

Pass an existing absolute directory in `project`:

```json
{"server":"serena","project":"/Users/me/Sites/shop","refresh":true}
```

Then call a tool against the same project:

```json
{
  "server": "serena",
  "project": "/Users/me/Sites/shop",
  "tool": "find_symbol",
  "arguments": {"name_path_pattern":"Order"}
}
```

Codebase memory works the same way:

```json
{"server":"codebase-memory","project":"/Users/me/Sites/shop","tool":"list_projects","arguments":{}}
```

`project` must be an absolute path to a directory that exists. Symlinks and `..` segments are canonicalized, so equivalent paths reuse one instance. When `project` is omitted, the configured server `cwd` is the default.

## Server configuration

`projectArg` controls how the project is passed to a server. The selected project is always used as the subprocess `cwd`; when `projectArg` is non-empty, the plugin also appends `[projectArg, canonicalProject]` to the configured arguments.

```yaml
servers:
  serena:
    command: /Users/me/.local/bin/serena
    args: [start-mcp-server, --context, claude-code]
    projectArg: --project
    cwd: /Users/me/Sites/default-project
  codebase-memory:
    command: /Users/me/.local/bin/codebase-memory-mcp
    args: []
    cwd: /Users/me/Sites/default-project
```

The bundled paths are examples/local defaults and can be overridden in the profile patch.

## Why a facade

Dynamic MCP tool names are unknown until `tools/list`, which requires starting the server. A four-tool facade preserves genuinely lazy startup and avoids adding dozens of schemas to every DSH request.

## Development

```bash
npm install --ignore-scripts
npm test
```
