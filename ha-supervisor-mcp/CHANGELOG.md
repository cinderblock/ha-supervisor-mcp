# Changelog

## 0.2.3

- Stops and restarts take about a second instead of ten, and a call in flight
  finishes instead of being cut off. The server runs as PID 1 without an init,
  so it ignored SIGTERM until Docker's SIGKILL 10 s later, which dropped any
  open request (a proxy in front reported `EOF`). It now stops accepting
  connections on SIGTERM, lets running calls finish for up to 8 s
  (`DRAIN_MS`), and exits.
- `GET /mcp` answers 405. The server is stateless and never pushes messages,
  but it used to accept the optional standalone SSE stream and hold every
  client's GET open forever. MCP clients treat 405 as "no stream" and carry on.

## 0.2.2

- `addon_restart` and `addon_write_file` with `restart: true` returned log
  lines from *before* the restart: Supervisor reports "started" before the
  add-on has logged anything. They now wait `settle_seconds` (default 5), then
  read `/addons/<slug>/logs/latest`, which covers only the current run.
- README: how to put TLS in front of the add-on and lock port 9584 to the
  proxy.

## 0.2.1

- `addon_logs` and the logs returned by `addon_restart` / `addon_write_file`
  returned one line too many: Supervisor's `Range: entries=:-N:` yields N+1
  entries. Trimmed to the newest N.

## 0.2.0

- **Renamed** from `ha-ops-mcp` to `ha-supervisor-mcp` (slug, image
  `ghcr.io/cinderblock/ha-supervisor-mcp`, repo). Nothing in it was specific to
  any one deployment. Reinstall from the new repository URL.
- Home Assistant-specific tools:
  - `system_overview`: Core, Supervisor and OS versions and pending updates,
    disk, health, and every add-on with its slug, state and config dir
  - `addon_list_files` / `addon_read_file` / `addon_write_file`: an add-on's
    config dir (`/addon_configs/<slug>`) addressed by slug.
    `addon_write_file` with `restart: true` applies and verifies in one call
  - `addon_restart`: restart, then return the state and the latest log lines
  - `addon_logs`
  - `core_check_config`: what `ha core check` does
- Environment overrides for running outside the add-on are now `DATA_DIR`,
  `FILE_ROOTS`, `ADDON_CONFIGS_DIR`, `EXEC_SHELL` and `PORT`

## 0.1.0 (initial)

- MCP server (Streamable HTTP, stateless) on port 9584 at `/mcp`, with
  bearer-token auth and a source-address allowlist (`allow_cidrs`)
- Tools: `read_file`, `write_file`, `list_dir`, `delete_path`, `exec`, `supervisor_api`
- Maps `/addon_configs` (all add-ons), `/config`, `/share`, `/ssl`, `/media`,
  `/backup` and `/addons` read-write. `hassio_role: manager`; no Docker, no host network
- Audit lines for every write, delete, exec and non-GET Supervisor call
- Bundles `ha` CLI 5.6.0
