import { loadConfig } from './config.ts';
import { startServer } from './server.ts';

/** Docker sends SIGKILL 10 s after SIGTERM; finish well inside that. */
const DRAIN_MS = Number(process.env.DRAIN_MS ?? 8000);

const config = await loadConfig();
const server = startServer(config);
console.log(
  `ha-supervisor-mcp: listening on :${server.port}/mcp; exec ${config.options.exec_enabled ? 'enabled' : 'disabled'}; ` +
    `roots ${config.roots.join(', ')}; allow ${config.options.allow_cidrs.join(', ')}`,
);

// The add-on runs as PID 1 with no init (config.yaml `init: false`), and PID 1
// has no default action for SIGTERM. Without this, every stop or restart waits
// out Docker's 10 s timeout and then SIGKILLs whatever call is in flight.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`ha-supervisor-mcp: ${signal}: no new connections; finishing calls in flight`);
    const deadline = setTimeout(() => {
      console.log(`ha-supervisor-mcp: calls still running after ${DRAIN_MS} ms; exiting anyway`);
      process.exit(0);
    }, DRAIN_MS);
    void server.stop().then(() => {
      clearTimeout(deadline);
      console.log('ha-supervisor-mcp: stopped');
      process.exit(0);
    });
  });
}
