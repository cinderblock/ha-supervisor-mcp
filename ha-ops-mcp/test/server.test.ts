// End to end: real HTTP server, real MCP client, temp dirs standing in for the
// add-on's volume maps, and a fake Supervisor.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig, type Config } from '../src/config.ts';
import { startServer } from '../src/server.ts';

let base: string;
let root: string;
let dataDir: string;
let config: Config;
let server: ReturnType<typeof startServer>;
let fakeSupervisor: ReturnType<typeof Bun.serve>;
const supervisorCalls: { method: string; path: string; body: unknown }[] = [];

async function writeOptions(options: Record<string, unknown>) {
  await writeFile(join(dataDir, 'options.json'), JSON.stringify(options));
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'ha-ops-mcp-e2e-'));
  root = join(base, 'addon_configs');
  dataDir = join(base, 'data');
  await mkdir(join(root, 'caddy'), { recursive: true });
  await mkdir(dataDir);
  fakeSupervisor = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = req.method === 'GET' ? undefined : await req.json();
      supervisorCalls.push({ method: req.method, path: new URL(req.url).pathname, body });
      if (req.headers.get('authorization') !== 'Bearer sup-token') return new Response('no', { status: 401 });
      return Response.json({ result: 'ok', data: { echo: new URL(req.url).pathname } });
    },
  });
  Object.assign(process.env, {
    OPS_DATA_DIR: dataDir,
    OPS_ROOTS: root,
    OPS_PORT: '0',
    SUPERVISOR_URL: `http://127.0.0.1:${fakeSupervisor.port}`,
    SUPERVISOR_TOKEN: 'sup-token',
  });
  // First start with rotate_token on: generates a token, then clears the flag.
  await writeOptions({ exec_enabled: true, rotate_token: true, allow_cidrs: ['127.0.0.0/8', '::1/128'] });
  config = await loadConfig();
  server = startServer(config);
});

afterAll(() => {
  server?.stop(true);
  fakeSupervisor?.stop(true);
});

function url() {
  return new URL(`http://127.0.0.1:${server.port}/mcp`);
}

async function connect(token = config.token) {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(url(), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = res.content[0]!.text;
  return { isError: res.isError ?? false, text, json: res.isError ? undefined : JSON.parse(text) };
}

describe('auth', () => {
  test('token persisted and rotate flag cleared via Supervisor', async () => {
    expect((await readFile(join(dataDir, 'token'), 'utf8')).trim()).toBe(config.token);
    const reset = supervisorCalls.find(c => c.path === '/addons/self/options');
    expect(reset?.body).toEqual({
      options: { exec_enabled: true, rotate_token: false, allow_cidrs: ['127.0.0.0/8', '::1/128'] },
    });
  });

  test('missing or wrong token is 401', async () => {
    const res = await fetch(url(), { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    await expect(connect('wrong')).rejects.toThrow();
  });

  test('other paths are 404', async () => {
    const res = await fetch(new URL('/', url()), { headers: { Authorization: `Bearer ${config.token}` } });
    expect(res.status).toBe(404);
  });

  test('source outside allow_cidrs is 403', async () => {
    const strict = startServer({ ...config, port: 0, cidrs: [] });
    try {
      const res = await fetch(`http://127.0.0.1:${strict.port}/mcp`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      expect(res.status).toBe(403);
    } finally {
      strict.stop(true);
    }
  });
});

describe('tools', () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect();
  });

  test('lists the expected tools', async () => {
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual(['delete_path', 'exec', 'list_dir', 'read_file', 'supervisor_api', 'write_file']);
  });

  test('write → read → list → conditional write → delete', async () => {
    const file = join(root, 'caddy', 'global.d', 'rethink.caddy');
    const w = await call(client, 'write_file', { path: file, content: 'layer4 {}\n', create_dirs: true });
    expect(w.isError).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('layer4 {}\n');

    const r = await call(client, 'read_file', { path: file });
    expect(r.json.content).toBe('layer4 {}\n');
    expect(r.json.sha256).toBe(w.json.sha256);

    const l = await call(client, 'list_dir', { path: root, recursive: true });
    expect(l.json.entries.map((e: { name: string }) => e.name)).toContain('caddy/global.d/rethink.caddy');

    const stale = await call(client, 'write_file', { path: file, content: 'x', if_sha256: 'deadbeef' });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('if_sha256 mismatch');
    const absent = await call(client, 'write_file', { path: file, content: 'x', if_sha256: 'absent' });
    expect(absent.isError).toBe(true);
    const ok = await call(client, 'write_file', { path: file, content: 'y', if_sha256: w.json.sha256 });
    expect(ok.json.previous_sha256).toBe(w.json.sha256);

    expect((await call(client, 'delete_path', { path: join(root, 'caddy', 'global.d') })).isError).toBe(true);
    expect((await call(client, 'delete_path', { path: join(root, 'caddy', 'global.d'), recursive: true })).isError).toBe(
      false,
    );
    expect((await call(client, 'delete_path', { path: root, recursive: true })).text).toContain('refusing');
  });

  test('delete_path removes a symlink, not its target', async () => {
    const target = join(root, 'keep');
    await mkdir(target);
    await writeFile(join(target, 'f'), 'x');
    const link = join(root, 'link');
    await symlink(target, link, 'junction');
    expect((await call(client, 'delete_path', { path: link })).isError).toBe(false);
    expect(await readFile(join(target, 'f'), 'utf8')).toBe('x');
  });

  test('paths outside the roots are refused', async () => {
    const r = await call(client, 'read_file', { path: join(dataDir, 'token') });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('outside the allowed roots');
  });

  test('exec: argv, stdin, exit code, timeout', async () => {
    const echo = await call(client, 'exec', {
      argv: [process.execPath, '-e', 'process.stdout.write(await Bun.stdin.text()); process.exit(3)'],
      stdin: 'hi',
    });
    expect(echo.json).toMatchObject({ exit_code: 3, stdout: 'hi', timed_out: false });

    const slow = await call(client, 'exec', {
      argv: [process.execPath, '-e', 'await Bun.sleep(10000)'],
      timeout_seconds: 1,
    });
    expect(slow.json.timed_out).toBe(true);

    expect((await call(client, 'exec', {})).isError).toBe(true);
  });

  test('supervisor_api passes through with the add-on token', async () => {
    const r = await call(client, 'supervisor_api', { method: 'POST', path: '/addons/x/restart', body: {} });
    expect(r.json).toEqual({ status: 200, body: { result: 'ok', data: { echo: '/addons/x/restart' } } });
  });
});

test('exec_enabled=false hides exec', async () => {
  const noExec = startServer({ ...config, port: 0, options: { ...config.options, exec_enabled: false } });
  try {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${noExec.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
      }),
    );
    expect((await client.listTools()).tools.map(t => t.name)).not.toContain('exec');
  } finally {
    noExec.stop(true);
  }
});
