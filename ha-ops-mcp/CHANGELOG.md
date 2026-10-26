# Changelog

## 0.1.0 — initial

- MCP server (Streamable HTTP, stateless) on port 9584 at `/mcp`, bearer-token auth,
  source-address allowlist (`allow_cidrs`)
- Tools: `read_file`, `write_file`, `list_dir`, `delete_path`, `exec`, `supervisor_api`
- Maps `/addon_configs` (all add-ons), `/config`, `/share`, `/ssl`, `/media`,
  `/backup`, `/addons` read-write. `hassio_role: manager`, no Docker, no host network
- Audit lines for every write, delete, exec and non-GET Supervisor call
- `ha` CLI 5.6.0 bundled
