# ha-supervisor-mcp

A Home Assistant add-on that gives an MCP client (Claude Code, etc.)
**Supervisor-level** access to a Home Assistant OS (or Supervised) host: add-on
config dirs, add-on restarts and logs, Core config checks, backups and other
files, a shell, and the Supervisor API. It's a companion to a Core-level MCP
server such as [ha-mcp](https://github.com/homeassistant-ai/ha-mcp), not a
replacement:

| Need | Use |
| --- | --- |
| Entities, automations, scripts, integrations, dashboards, HA config | ha-mcp |
| An add-on's config files (`/addon_configs/<slug>`): edit, restart, check its log | **ha-supervisor-mcp** |
| Files anywhere under `/config`, `/share`, `/ssl`, `/media`, `/backup`, `/addons` | **ha-supervisor-mcp** |
| A shell on the box (`ha` CLI, curl, jq, git, python3) | **ha-supervisor-mcp** |
| Raw Supervisor API calls | **ha-supervisor-mcp** |

ha-mcp's file tools run inside the HA Core container, which only mounts
`/config`, `/ssl`, `/share` and `/media`, so it can never reach another add-on's
config dir. This add-on maps those volumes into its own container instead.

## Tools

Home Assistant tools:

| Tool | What it does |
| --- | --- |
| `system_overview` | Core, Supervisor and OS versions and pending updates, disk, health, and every add-on (slug, state, version, config dir). Start here |
| `addon_list_files` | List an add-on's config dir, by slug |
| `addon_read_file` | Read a file in an add-on's config dir |
| `addon_write_file` | Write a file in an add-on's config dir; with `restart: true`, also restart the add-on and return its state and latest log lines |
| `addon_restart` | Restart an add-on, then return its state and latest log lines |
| `addon_logs` | An add-on's latest log lines |
| `core_check_config` | Validate Core's configuration, as `ha core check` does. Run it before restarting Core after editing `/config` |

General tools, for anything the tools above don't cover:

| Tool | What it does |
| --- | --- |
| `read_file` | Read a file (utf8 or base64, with offset/limit). Returns sha256, size, mtime, mode |
| `write_file` | Atomic create/replace. `if_sha256` guards against clobbering a concurrent edit; `"absent"` means "must not exist yet" |
| `list_dir` | List a directory, optionally recursively |
| `delete_path` | Delete a file, or a directory with `recursive: true`. The roots themselves can't be deleted |
| `exec` | Run a command (`command` via `bash -c`, or `argv`) with a timeout. Can be turned off with `exec_enabled: false` |
| `supervisor_api` | Call the Supervisor REST API with the add-on's own token (manager role) |

File tools only accept paths inside the mapped roots (`addon_*` tools: inside
that add-on's dir), and symlinks are resolved before that check. `exec` runs as root inside the add-on container, so
it can reach the same volumes and nothing more.

## What it can and can't do

- **Can:** read and write every add-on's config dir, HA's config dir and the
  shared volumes. Manage add-ons, backups and updates through the `ha` CLI or the
  Supervisor API (manager role).
  The manager role also reaches `/host/*` (reboot, shutdown) and most of
  `/os/*` (updates).
- **Can't:** use Docker, see the host's processes or network namespace, or load
  kernel modules. It has no `docker_api`, no `host_network`, no extra
  privileges, and protection mode stays on. The Supervisor also refuses manager
  calls that would undo that boundary: changing an add-on's security settings
  (`/addons/<slug>/security`, so protection mode), `/os/datadisk/wipe`, and the
  HAOS host's own SSH keys (`/os/ssh/authorized_keys`). See the `ROLE_MANAGER`
  rule in Supervisor's
  [`api/middleware/security.py`](https://github.com/home-assistant/supervisor/blob/main/supervisor/api/middleware/security.py).

Treat a client holding the token as an administrator of the box. Every write,
delete, restart, exec and non-GET Supervisor call is logged (`audit ...` lines) to the
add-on log.

## Install

In Home Assistant: **Settings → Add-ons → ⋮ → Repositories → Add**, paste

```
https://github.com/cinderblock/ha-supervisor-mcp
```

Install **HA Supervisor MCP**, review the options, and start it. The add-on log shows
the bearer token **once**, on first start:

```
ha-supervisor-mcp: new bearer token generated: <token>
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `exec_enabled` | `true` | Register the `exec` tool |
| `rotate_token` | `false` | On next start, generate and log a new token, then set this back to `false` |
| `allow_cidrs` | RFC 1918 + loopback | Source addresses allowed to connect; anything else gets 403 |

## Connect a client

Claude Code (`~/.claude.json`, or `claude mcp add`):

```json
"ha-supervisor": {
  "type": "http",
  "url": "http://homeassistant.local:9584/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

The endpoint is plain HTTP on the LAN, the same as ha-mcp's. Don't expose
port 9584 beyond networks you trust.

## Develop

```sh
cd ha-supervisor-mcp
bun install
bun run typecheck
bun test
```

The tests run the real HTTP server and MCP client against temp directories and
a fake Supervisor. For a local run, set `DATA_DIR` (containing an
`options.json`), `FILE_ROOTS` (comma-separated), `ADDON_CONFIGS_DIR`, `PORT`
and, if `bash` isn't at `/bin/bash`, `EXEC_SHELL`.

CI (`.github/workflows/build.yaml`) tests, then builds natively on amd64 and
arm64 runners, then publishes the multi-arch `ghcr.io/cinderblock/ha-supervisor-mcp:<version>`
that the add-on's `config.yaml` points at. Bump `version` in **both**
`config.yaml` and `package.json` (a test checks they match) and add a
`CHANGELOG.md` entry for each release.
