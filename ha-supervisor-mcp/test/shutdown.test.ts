// SIGTERM handling in the real entry point (src/main.ts), run as a child
// process: a stop must finish the call in flight, then exit promptly, instead
// of ignoring the signal until Docker's SIGKILL. POSIX signals only, so this
// is skipped on Windows (CI runs it on Linux).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOKEN = 'shutdown-test-token';
let child: ReturnType<typeof Bun.spawn> | undefined;

afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
});

async function start(drainMs: number) {
  const base = await mkdtemp(join(tmpdir(), 'ha-supervisor-mcp-shutdown-'));
  const dataDir = join(base, 'data');
  const root = join(base, 'addon_configs');
  await mkdir(dataDir);
  await mkdir(root);
  await writeFile(
    join(dataDir, 'options.json'),
    JSON.stringify({ exec_enabled: true, rotate_token: false, allow_cidrs: ['127.0.0.0/8', '::1/128'] }),
  );
  await writeFile(join(dataDir, 'token'), TOKEN + '\n');
  const proc = Bun.spawn([process.execPath, 'run', join(import.meta.dir, '..', 'src', 'main.ts')], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      FILE_ROOTS: root,
      ADDON_CONFIGS_DIR: root,
      PORT: '0',
      DRAIN_MS: String(drainMs),
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  child = proc;

  // Read stdout until the listening line names the port, and keep collecting.
  const decoder = new TextDecoder();
  let out = '';
  const reader = proc.stdout.getReader();
  let port: number | undefined;
  while (port === undefined) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`exited before listening:\n${out}`);
    out += decoder.decode(value);
    const m = out.match(/listening on :(\d+)\/mcp/);
    if (m) port = Number(m[1]);
  }
  const rest = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return out;
      out += decoder.decode(value);
    }
  })();
  return { proc, port, output: rest };
}

async function connect(port: number) {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );
  return client;
}

describe.skipIf(process.platform === 'win32')('SIGTERM', () => {
  test('finishes the call in flight, refuses new connections, exits 0 promptly', async () => {
    const { proc, port, output } = await start(8000);
    const client = await connect(port);
    const inFlight = client.callTool({
      name: 'exec',
      arguments: { argv: [process.execPath, '-e', 'await Bun.sleep(1500); console.log("finished")'] },
    });
    await Bun.sleep(300);

    const signalled = performance.now();
    proc.kill('SIGTERM');
    await Bun.sleep(100);
    await expect(fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' })).rejects.toThrow();

    const res = (await inFlight) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError ?? false).toBe(false);
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ exit_code: 0, stdout: 'finished\n' });

    expect(await proc.exited).toBe(0);
    expect(performance.now() - signalled).toBeLessThan(4000);
    expect(await output).toContain('ha-supervisor-mcp: stopped');
  });

  test('exits when idle at once, and gives up on a call that outlasts the drain', async () => {
    const idle = await start(8000);
    const t0 = performance.now();
    idle.proc.kill('SIGTERM');
    expect(await idle.proc.exited).toBe(0);
    expect(performance.now() - t0).toBeLessThan(1500);

    const busy = await start(500);
    const client = await connect(busy.port);
    void client
      .callTool({ name: 'exec', arguments: { argv: [process.execPath, '-e', 'await Bun.sleep(30000)'] } })
      .catch(() => {});
    await Bun.sleep(300);
    const t1 = performance.now();
    busy.proc.kill('SIGTERM');
    expect(await busy.proc.exited).toBe(0);
    expect(performance.now() - t1).toBeLessThan(2500);
    expect(await busy.output).toContain('still running after 500 ms');
  });
});
