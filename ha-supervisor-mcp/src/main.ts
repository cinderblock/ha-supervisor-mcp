import { loadConfig } from './config.ts';
import { startServer } from './server.ts';

const config = await loadConfig();
const server = startServer(config);
console.log(
  `ha-supervisor-mcp: listening on :${server.port}/mcp; exec ${config.options.exec_enabled ? 'enabled' : 'disabled'}; ` +
    `roots ${config.roots.join(', ')}; allow ${config.options.allow_cidrs.join(', ')}`,
);
