// HTTP front end: source-address allowlist, bearer token, then a stateless
// MCP Streamable HTTP transport per request.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ipAllowed, tokenMatches } from './auth.ts';
import type { Config } from './config.ts';
import { registerHaTools } from './ha-tools.ts';
import { registerTools } from './tools.ts';
import pkg from '../package.json' with { type: 'json' };

const INSTRUCTIONS = `Supervisor-level access to a Home Assistant OS (or Supervised) host.
For Home Assistant itself (entities, automations, integrations, dashboards) prefer a Core-level
MCP server such as ha-mcp if one is connected. Use these tools for what lives outside Core:
- system_overview first: versions, pending updates, disk, and every add-on with its slug and config dir.
- addon_read_file / addon_write_file / addon_list_files for an add-on's config dir
  (/addon_configs/<slug>); addon_write_file with restart=true applies and verifies in one call.
- addon_restart, addon_logs, core_check_config (run it before restarting Core after editing /config).
- read_file / write_file / list_dir / delete_path for any path under /config, /addon_configs,
  /share, /ssl, /media, /backup, /addons.
- exec for anything else (bash, the \`ha\` CLI), supervisor_api for raw Supervisor calls.
Every write, delete, restart, exec and non-GET Supervisor call is logged to this add-on's log.`;

export function startServer(config: Config) {
  return Bun.serve({
    port: config.port,
    // exec may legitimately run for up to 10 minutes.
    idleTimeout: 0,
    async fetch(req, srv) {
      const ip = srv.requestIP(req)?.address;
      if (!ip || !ipAllowed(ip, config.cidrs)) {
        console.log(`denied: source ${ip ?? 'unknown'} not in allow_cidrs`);
        return new Response('forbidden\n', { status: 403 });
      }
      if (new URL(req.url).pathname !== '/mcp') return new Response('not found\n', { status: 404 });
      if (!tokenMatches(req.headers.get('authorization'), config.token)) {
        console.log(`denied: bad or missing bearer token from ${ip}`);
        return new Response('unauthorized\n', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
      }
      const server = new McpServer({ name: 'ha-supervisor-mcp', version: pkg.version }, { instructions: INSTRUCTIONS });
      registerHaTools(server, config);
      registerTools(server, config);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return transport.handleRequest(req);
    },
  });
}
