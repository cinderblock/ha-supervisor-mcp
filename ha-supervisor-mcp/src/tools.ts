// Generic tools: files anywhere under the mapped roots, a shell, and a raw
// Supervisor passthrough. The Home Assistant-specific tools are in ha-tools.ts.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './config.ts';
import { audit, deletePathAt, listDirAt, readFileAt, writeFileAt } from './files.ts';
import { supervisor } from './supervisor.ts';

export function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export const fileArgs = {
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  offset: z.number().int().min(0).default(0).describe('Byte offset to start at'),
  max_bytes: z
    .number()
    .int()
    .min(1)
    .max(16 * 1024 * 1024)
    .default(1024 * 1024),
};

export const writeArgs = {
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  if_sha256: z.string().optional().describe('Expected current sha256 (from a read), or "absent" for a new file'),
  mode: z
    .string()
    .regex(/^[0-7]{3,4}$/)
    .optional()
    .describe('Octal file mode, e.g. "644"; default keeps the existing mode'),
  create_dirs: z.boolean().default(false).describe('Create missing parent directories'),
};

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
        `Read any file under ${rootsList}. For an add-on's own config, addon_read_file is simpler. ` +
        'Returns content plus size, sha256 (of the whole file) and mtime; pass the sha256 to write_file as ' +
        'if_sha256 to avoid clobbering a concurrent edit.',
      inputSchema: { path: z.string().describe('Absolute path, e.g. /config/configuration.yaml'), ...fileArgs },
      annotations: { readOnlyHint: true },
    },
    async ({ path, ...opts }) => result(await readFileAt(path, config.roots, opts)),
  );

  server.registerTool(
    'write_file',
    {
      description:
        `Create or replace any file under ${rootsList} (atomic: temp file + rename). ` +
        'if_sha256 makes it fail instead of overwriting a file that changed; "absent" requires a new file.',
      inputSchema: { path: z.string(), ...writeArgs },
      annotations: { destructiveHint: true },
    },
    async ({ path, ...opts }) => result(await writeFileAt(path, config.roots, opts)),
  );

  server.registerTool(
    'list_dir',
    {
      description: `List a directory under ${rootsList}.`,
      inputSchema: {
        path: z.string(),
        recursive: z.boolean().default(false),
        max_entries: z.number().int().min(1).max(20000).default(2000),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, ...opts }) => result(await listDirAt(path, config.roots, opts)),
  );

  server.registerTool(
    'delete_path',
    {
      description:
        `Delete a file, or a directory with recursive=true, under ${rootsList}. ` +
        'A symlink is removed itself, never its target. The roots themselves cannot be deleted.',
      inputSchema: { path: z.string(), recursive: z.boolean().default(false) },
      annotations: { destructiveHint: true },
    },
    async ({ path, ...opts }) => result(await deletePathAt(path, config.roots, opts)),
  );

  if (config.options.exec_enabled) {
    server.registerTool(
      'exec',
      {
        description:
          'Run a command as root inside this add-on\'s container on the Home Assistant host. ' +
          `It sees ${rootsList} (all read-write) and has the \`ha\` CLI (manager role), bash, curl, jq, git ` +
          'and python3. Give either `command` (run with bash -c) or `argv`. There is no Docker and no access ' +
          'to host namespaces; other add-ons are managed through the `ha` CLI or the Supervisor tools.',
        inputSchema: {
          command: z.string().optional().describe('Shell command, run as bash -c <command>'),
          argv: z.array(z.string()).min(1).optional().describe('Program and arguments, no shell'),
          cwd: z.string().default('/'),
          stdin: z.string().optional(),
          timeout_seconds: z.number().int().min(1).max(600).default(60),
          max_output_bytes: z
            .number()
            .int()
            .min(1024)
            .max(4 * 1024 * 1024)
            .default(256 * 1024),
        },
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      async ({ command, argv, cwd, stdin, timeout_seconds, max_output_bytes }) => {
        if ((command === undefined) === (argv === undefined)) throw new Error('give exactly one of command or argv');
        const cmd = argv ?? [config.shell, '-c', command!];
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
        'Raw Home Assistant Supervisor REST API call (manager role), for anything the dedicated tools ' +
        "don't cover, e.g. GET /addons/<slug>/info, POST /backups/new/partial, GET /resolution/info. " +
        'Returns the HTTP status and the parsed body. The HA Core REST API is reachable under /core/api/.',
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
