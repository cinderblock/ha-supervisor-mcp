// The MCP tools. File tools are confined to the configured roots; exec and the
// Supervisor passthrough are what make this a full-access server.

import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './config.ts';
import { isRoot, PathError, resolveAllowed } from './paths.ts';
import { supervisor } from './supervisor.ts';

/** One line per state-changing call, to the add-on log. */
export function audit(event: string, detail: Record<string, unknown>): void {
  console.log(`audit ${event} ${JSON.stringify(detail)}`);
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const sha256 = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex');

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

async function readCapped(stream: ReadableStream<Uint8Array>, cap: number) {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (kept < cap) {
      const piece = chunk.subarray(0, cap - kept);
      chunks.push(piece);
      kept += piece.length;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes: total, truncated: total > kept };
}

export function registerTools(server: McpServer, config: Config): void {
  const rootsList = config.roots.join(', ');

  server.registerTool(
    'read_file',
    {
      description:
        `Read a file on the Home Assistant host. Allowed roots: ${rootsList}. ` +
        '/config is the HA config dir; /addon_configs/<slug> holds each add-on\'s config. ' +
        'Returns content plus size, sha256 (of the whole file) and mtime. Use the sha256 as ' +
        'write_file\'s if_sha256 to avoid clobbering concurrent edits.',
      inputSchema: {
        path: z.string().describe('Absolute path, e.g. /addon_configs/2e1e557c_caddy-dns01/global.d/x.caddy'),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
        offset: z.number().int().min(0).default(0).describe('Byte offset to start at'),
        max_bytes: z.number().int().min(1).max(16 * 1024 * 1024).default(1024 * 1024),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, encoding, offset, max_bytes }) => {
      const { path: real } = await resolveAllowed(path, config.roots);
      const st = await stat(real);
      if (!st.isFile()) throw new PathError(`not a regular file: ${path}`);
      const buf = await readFile(real);
      const slice = buf.subarray(offset, offset + max_bytes);
      return result({
        path: real,
        size: st.size,
        sha256: sha256(buf),
        mtime: st.mtime.toISOString(),
        mode: (st.mode & 0o7777).toString(8),
        offset,
        returned_bytes: slice.length,
        truncated: offset + slice.length < buf.length,
        encoding,
        content: Buffer.from(slice).toString(encoding),
      });
    },
  );

  server.registerTool(
    'write_file',
    {
      description:
        `Create or replace a file on the Home Assistant host (atomic: temp file + rename). Allowed roots: ${rootsList}. ` +
        'Pass if_sha256 (from read_file) to fail instead of overwriting a file that changed, or "absent" to ' +
        'require that the file does not exist yet. Keeps the existing mode unless mode is given.',
      inputSchema: {
        path: z.string(),
        content: z.string(),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
        if_sha256: z.string().optional().describe('Expected current sha256, or "absent"'),
        mode: z
          .string()
          .regex(/^[0-7]{3,4}$/)
          .optional()
          .describe('Octal file mode, e.g. "644"'),
        create_dirs: z.boolean().default(false).describe('Create missing parent directories'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path, content, encoding, if_sha256, mode, create_dirs }) => {
      const { path: real } = await resolveAllowed(path, config.roots);
      let existingMode: number | undefined;
      let previous: string | null = null;
      try {
        const st = await stat(real);
        if (!st.isFile()) throw new PathError(`not a regular file: ${path}`);
        existingMode = st.mode & 0o7777;
        previous = sha256(await readFile(real));
      } catch (e) {
        if (errnoCode(e) !== 'ENOENT') throw e;
      }
      if (if_sha256 !== undefined) {
        const expected = if_sha256 === 'absent' ? null : if_sha256.toLowerCase();
        if (expected !== previous) {
          throw new Error(`if_sha256 mismatch for ${path}: expected ${if_sha256}, file is ${previous ?? 'absent'}`);
        }
      }
      if (create_dirs) await mkdir(dirname(real), { recursive: true });
      const data = Buffer.from(content, encoding);
      const fileMode = mode !== undefined ? parseInt(mode, 8) : (existingMode ?? 0o644);
      const tmp = join(dirname(real), `.${basename(real)}.ha-ops-mcp-${randomBytes(4).toString('hex')}`);
      await writeFile(tmp, data, { mode: fileMode });
      await rename(tmp, real);
      const digest = sha256(data);
      audit('write_file', { path: real, bytes: data.length, sha256: digest, previous_sha256: previous });
      return result({ path: real, bytes: data.length, sha256: digest, previous_sha256: previous, mode: fileMode.toString(8) });
    },
  );

  server.registerTool(
    'list_dir',
    {
      description: `List a directory on the Home Assistant host. Allowed roots: ${rootsList}.`,
      inputSchema: {
        path: z.string(),
        recursive: z.boolean().default(false),
        max_entries: z.number().int().min(1).max(20000).default(2000),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, recursive, max_entries }) => {
      const { path: real } = await resolveAllowed(path, config.roots);
      const entries: Record<string, unknown>[] = [];
      let truncated = false;
      const walk = async (dir: string, prefix: string): Promise<void> => {
        for (const name of (await readdir(dir)).sort()) {
          if (entries.length >= max_entries) {
            truncated = true;
            return;
          }
          const full = join(dir, name);
          const st = await lstat(full);
          const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
          entries.push({
            name: prefix + name,
            type,
            size: st.size,
            mtime: st.mtime.toISOString(),
            mode: (st.mode & 0o7777).toString(8),
            ...(type === 'symlink' ? { target: await readlink(full) } : {}),
          });
          if (recursive && type === 'dir') await walk(full, `${prefix}${name}/`);
        }
      };
      await walk(real, '');
      return result({ path: real, count: entries.length, truncated, entries });
    },
  );

  server.registerTool(
    'delete_path',
    {
      description:
        `Delete a file, or a directory with recursive=true, on the Home Assistant host. Allowed roots: ${rootsList}. ` +
        'The roots themselves cannot be deleted.',
      inputSchema: { path: z.string(), recursive: z.boolean().default(false) },
      annotations: { destructiveHint: true },
    },
    async ({ path, recursive }) => {
      if (isRoot(await resolveAllowed(path, config.roots))) throw new PathError(`refusing to delete a root: ${path}`);
      // Resolve only the parent, so a symlink is removed itself rather than its target.
      const parent = await resolveAllowed(dirname(path), config.roots);
      const target = join(parent.path, basename(path));
      const st = await lstat(target);
      if (st.isDirectory() && !recursive) throw new Error(`${path} is a directory; pass recursive=true`);
      await rm(target, { recursive });
      audit('delete_path', { path: target, recursive });
      return result({ deleted: target });
    },
  );

  if (config.options.exec_enabled) {
    server.registerTool(
      'exec',
      {
        description:
          'Run a command inside the ha-ops-mcp add-on container on the Home Assistant host, as root. ' +
          `It sees ${rootsList} (all read-write) and has the \`ha\` CLI (manager role), bash, curl, jq, git, ` +
          'python3. Give either `command` (run with bash -c) or `argv`. No Docker and no host namespaces: ' +
          'use the `ha` CLI or the supervisor_api tool for add-on/host/OS actions.',
        inputSchema: {
          command: z.string().optional().describe('Shell command, run as bash -c <command>'),
          argv: z.array(z.string()).min(1).optional().describe('Program and arguments, no shell'),
          cwd: z.string().default('/'),
          stdin: z.string().optional(),
          timeout_seconds: z.number().int().min(1).max(600).default(60),
          max_output_bytes: z.number().int().min(1024).max(4 * 1024 * 1024).default(256 * 1024),
        },
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      async ({ command, argv, cwd, stdin, timeout_seconds, max_output_bytes }) => {
        if ((command === undefined) === (argv === undefined)) throw new Error('give exactly one of command or argv');
        const cmd = argv ?? [process.env.OPS_SHELL ?? '/bin/bash', '-c', command!];
        audit('exec', { argv: cmd, cwd });
        const started = Date.now();
        const proc = Bun.spawn(cmd, {
          cwd,
          stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill('SIGKILL');
        }, timeout_seconds * 1000);
        const [stdout, stderr, exitCode] = await Promise.all([
          readCapped(proc.stdout, max_output_bytes),
          readCapped(proc.stderr, max_output_bytes),
          proc.exited,
        ]);
        clearTimeout(timer);
        audit('exec_done', { exit_code: exitCode, timed_out: timedOut, ms: Date.now() - started });
        return result({
          exit_code: exitCode,
          signal: proc.signalCode,
          timed_out: timedOut,
          duration_ms: Date.now() - started,
          stdout: stdout.text,
          stdout_bytes: stdout.bytes,
          stdout_truncated: stdout.truncated,
          stderr: stderr.text,
          stderr_bytes: stderr.bytes,
          stderr_truncated: stderr.truncated,
        });
      },
    );
  }

  server.registerTool(
    'supervisor_api',
    {
      description:
        'Call the Home Assistant Supervisor REST API directly (manager role), e.g. GET /addons, ' +
        'GET /addons/<slug>/info, POST /addons/<slug>/restart, GET /host/info, POST /backups/new/full. ' +
        'Returns the HTTP status and the parsed body. The HA Core API is under /core/api/.',
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).default('GET'),
        path: z.string().describe('Starts with "/", e.g. /addons/self/info'),
        body: z.unknown().optional().describe('JSON body for POST/PUT/PATCH'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ method, path, body }) => {
      if (method !== 'GET') audit('supervisor_api', { method, path });
      return result(await supervisor(method, path, body));
    },
  );
}
