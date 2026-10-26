// Runtime configuration: add-on options from <data>/options.json, plus a few
// environment overrides so the server can run outside the add-on for tests.

import { randomBytes } from 'node:crypto';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseCidr, type Cidr } from './auth.ts';
import { supervisor } from './supervisor.ts';

const Options = z.object({
  exec_enabled: z.boolean(),
  rotate_token: z.boolean(),
  allow_cidrs: z.array(z.string()).min(1),
});
export type Options = z.infer<typeof Options>;

/** Where the add-on's volume maps land (see config.yaml `map:`). */
const DEFAULT_ROOTS = ['/addon_configs', '/config', '/share', '/ssl', '/media', '/backup', '/addons'];

export interface Config {
  options: Options;
  cidrs: Cidr[];
  roots: string[];
  port: number;
  token: string;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

async function loadToken(dataDir: string, options: Options): Promise<string> {
  const file = join(dataDir, 'token');
  if (options.rotate_token) {
    await rm(file, { force: true });
  } else {
    try {
      return (await readFile(file, 'utf8')).trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  const token = randomBytes(32).toString('base64url');
  await writeFile(file, token + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
  // Printed once per generation so it can be copied into the MCP client.
  console.log(`ha-ops-mcp: new bearer token generated: ${token}`);
  console.log('ha-ops-mcp: send it as "Authorization: Bearer <token>". It is not printed again.');
  return token;
}

/** Flip rotate_token back off so the next restart keeps the new token. */
async function clearRotateFlag(options: Options): Promise<void> {
  const res = await supervisor('POST', '/addons/self/options', {
    options: { ...options, rotate_token: false },
  });
  if (res.status !== 200) {
    throw new Error(`could not reset rotate_token via Supervisor: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

export async function loadConfig(): Promise<Config> {
  const dataDir = env('OPS_DATA_DIR') ?? '/data';
  const options = Options.parse(JSON.parse(await readFile(join(dataDir, 'options.json'), 'utf8')));
  const cidrs = options.allow_cidrs.map(parseCidr);
  const roots = env('OPS_ROOTS')?.split(',') ?? DEFAULT_ROOTS;
  const port = Number(env('OPS_PORT') ?? 9584);
  const token = await loadToken(dataDir, options);
  if (options.rotate_token) await clearRotateFlag(options);
  return { options: { ...options, rotate_token: false }, cidrs, roots, port, token };
}
