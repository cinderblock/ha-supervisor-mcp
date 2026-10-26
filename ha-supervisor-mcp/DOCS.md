# HA Supervisor MCP

Supervisor-level MCP server for agents, as a companion to a Core-level MCP server
such as ha-mcp. Tools: `system_overview`; `addon_list_files`, `addon_read_file`
and `addon_write_file` (with an optional restart) for any add-on's config dir;
`addon_restart`; `addon_logs`; `core_check_config`; general file tools; `exec`;
and `supervisor_api`.

## First start

The log prints the bearer token once:

```
ha-supervisor-mcp: new bearer token generated: <token>
```

Point your MCP client at `http://<this host>:9584/mcp` with the header
`Authorization: Bearer <token>`.

To replace the token, set `rotate_token` to `true` and restart. The add-on logs
a new token and sets the option back to `false`.

## Options

- `exec_enabled`: register the `exec` (shell) tool.
- `rotate_token`: generate a new token on the next start.
- `allow_cidrs`: client source addresses allowed to connect.

## Security

Whoever holds the token can read and write every add-on's config, HA's config
and the backups, and can manage add-ons. Treat it like an admin password. The
add-on has no Docker access and no host network or extra privileges, and every
state-changing call (writes, deletes, restarts, exec, non-GET Supervisor calls) is logged here as an `audit` line.

Full documentation: <https://github.com/cinderblock/ha-supervisor-mcp>
