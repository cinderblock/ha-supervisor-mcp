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
let checkFails = false;
const fakeData = {
  '/info': { machine: 'yellow', arch: 'aarch64', supported: true, healthy: true },
  '/host/info': { hostname: 'homeassistant', disk_total: 100, disk_used: 40, disk_free: 60 },
  '/core/info': { version: '2026.10.1', version_latest: '2026.10.2', update_available: true },
  '/os/info': { version: '17.0', version_latest: '17.0', update_available: false, board: 'yellow' },
  '/supervisor/info': { version: '2026.10.0', version_latest: '2026.10.0', update_available: false, channel: 'stable' },
  '/addons': {
    addons: [
      { slug: 'caddy', name: 'Caddy', state: 'started', version: '1', version_latest: '2', update_available: true, repository: 'x' },
      { slug: 'nodir', name: 'No dir', state: 'stopped', version: '1', version_latest: '1', update_available: false, repository: 'x' },
    ],
  },
  '/addons/caddy/info': { state: 'started', version: '1' },
};

async function writeOptions(options: Record<string, unknown>) {
  await writeFile(join(dataDir, 'options.json'), JSON.stringify(options));
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'ha-supervisor-mcp-e2e-'));
  root = join(base, 'addon_configs');
  dataDir = join(base, 'data');
  await mkdir(join(root, 'caddy'), { recursive: true });
  await mkdir(dataDir);
  fakeSupervisor = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      const body = text ? JSON.parse(text) : undefined;
      supervisorCalls.push({ method: req.method, path: new URL(req.url).pathname, body });
      if (req.headers.get('authorization') !== 'Bearer sup-token') return new Response('no', { status: 401 });
      const path = new URL(req.url).pathname;
      if (path === '/addons/caddy/logs') {
        // Mimic Supervisor: `entries=:-N:` yields N+1 entries.
        const n = Number(req.headers.get('range')?.match(/^entries=:-(\d+):$/)?.[1]);
        const lines = Array.from({ length: n + 1 }, (_, i) => `line${i} accept=${req.headers.get('accept')}`);
        return new Response(lines.join('\n') + '\n', { headers: { 'Content-Type': 'text/plain' } });
      }
      if (path === '/addons/caddy/logs/latest') {
        // Mimic Supervisor: the whole log of the current container run, no Range.
        const lines = Array.from({ length: 9 }, (_, i) => `run${i} accept=${req.headers.get('accept')}`);
        return new Response(lines.join('\n') + '\n', { headers: { 'Content-Type': 'text/plain' } });
      }
      if (path === '/core/check' && checkFails) {
        return Response.json({ result: 'error', message: 'Invalid config for [http]' }, { status: 400 });
      }
      const data = (fakeData as Record<string, unknown>)[path] ?? { echo: path };
      return Response.json({ result: 'ok', data });
    },
  });
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    FILE_ROOTS: root,
    ADDON_CONFIGS_DIR: root,
    PORT: '0',
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

  test('GET (standalone SSE stream) is 405, and a client still connects', async () => {
    const res = await fetch(url(), {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, DELETE');
    const client = await connect();
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
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
    expect(names).toEqual([
      'addon_list_files',
      'addon_logs',
      'addon_read_file',
      'addon_restart',
      'addon_write_file',
      'core_check_config',
      'delete_path',
      'exec',
      'list_dir',
      'read_file',
      'supervisor_api',
      'system_overview',
      'write_file',
    ]);
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

  test('system_overview combines Supervisor info and marks config dirs', async () => {
    const r = await call(client, 'system_overview', {});
    expect(r.json).toMatchObject({
      hostname: 'homeassistant',
      core: { version: '2026.10.1', update_available: true },
      disk: { free_gb: 60 },
    });
    const bySlug = Object.fromEntries(r.json.addons.map((a: { slug: string }) => [a.slug, a]));
    expect(bySlug.caddy).toMatchObject({ config_dir: join(root, 'caddy'), version_latest: '2' });
    expect(bySlug.nodir.config_dir).toBeNull();
  });

  test('addon_* file tools are confined to the add-on dir', async () => {
    const w = await call(client, 'addon_write_file', {
      slug: 'caddy',
      path: 'sites.d/a.caddy',
      content: 'a {}\n',
      create_dirs: true,
      restart: true,
      log_lines: 7,
      settle_seconds: 0,
    });
    expect(w.isError).toBe(false);
    expect(await readFile(join(root, 'caddy', 'sites.d', 'a.caddy'), 'utf8')).toBe('a {}\n');
    expect(w.json.restart).toMatchObject({ slug: 'caddy', state: 'started' });
    // Restart results come from /logs/latest (this run only), trimmed to log_lines.
    expect(w.json.restart.logs).toBe([2, 3, 4, 5, 6, 7, 8].map(i => `run${i} accept=text/plain`).join('\n') + '\n');
    // addon_logs still reads the journal tail across runs (Range: entries=:-N: → N+1, trimmed).
    const tail = await call(client, 'addon_logs', { slug: 'caddy', lines: 3 });
    expect(tail.json.logs).toBe([1, 2, 3].map(i => `line${i} accept=text/plain`).join('\n') + '\n');
    expect(supervisorCalls.some(c => c.method === 'POST' && c.path === '/addons/caddy/restart')).toBe(true);

    const r = await call(client, 'addon_read_file', { slug: 'caddy', path: 'sites.d/a.caddy' });
    expect(r.json.content).toBe('a {}\n');
    const l = await call(client, 'addon_list_files', { slug: 'caddy' });
    expect(l.json.entries.map((e: { name: string }) => e.name)).toContain('sites.d/a.caddy');

    const escape = await call(client, 'addon_read_file', { slug: 'caddy', path: '../other/x' });
    expect(escape.isError).toBe(true);
    expect(escape.text).toContain('outside the allowed roots');
    const badSlug = await call(client, 'addon_read_file', { slug: '../caddy', path: 'x' });
    expect(badSlug.isError).toBe(true);
    const noDir = await call(client, 'addon_list_files', { slug: 'nodir' });
    expect(noDir.text).toContain('does not exist');
  });

  test('core_check_config reports valid, and surfaces the error when not', async () => {
    expect((await call(client, 'core_check_config', {})).json).toEqual({ valid: true });
    checkFails = true;
    try {
      const bad = await call(client, 'core_check_config', {});
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain('Invalid config for [http]');
    } finally {
      checkFails = false;
    }
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
