# dsh-lazy-mcp

Lazy, on-demand MCP bridge for DeepSeek Harness. It registers four lightweight facade tools at DSH startup and does **not** spawn an MCP subprocess until a facade tool actually needs it.

## Tools

- `lazy_mcp_status` — inspect state without starting anything.
- `lazy_mcp_list_tools` — start one server and fetch its advertised tools.
- `lazy_mcp_call_tool` — validate a raw name against the advertised list and call it.
- `lazy_mcp_stop` — stop one server or all servers.

Connections are cached and stopped after the configured idle timeout (default 5 minutes). Plugin unload closes every child process.

## Configured servers

- `serena` — semantic/LSP tools for `/Users/hoaiminh/Sites/localhost/tingnect`.
- `codebase-memory` — persistent code graph and ADR/context tools for the same project.

## Why a facade

Dynamic MCP tool names are unknown until `tools/list`, which requires starting the server. A four-tool facade preserves genuinely lazy startup and avoids adding dozens of schemas to every DSH request.

## Development

```bash
npm install --ignore-scripts
npm test
```
