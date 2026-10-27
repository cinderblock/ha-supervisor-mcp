// Home Assistant-specific tools: add-on config dirs addressed by add-on slug,
// restart-and-check, logs, a Core config check, and a one-call system overview.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './config.ts';
import { audit, listDirAt, readFileAt, writeFileAt } from './files.ts';
import { PathError } from './paths.ts';
import { addonLogs, addonLogsSinceStart, supervisorData } from './supervisor.ts';
import { fileArgs, result, writeArgs } from './tools.ts';

const slugArg = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'an add-on slug, e.g. 2e1e557c_caddy-dns01')
  .describe('Full add-on slug including the repository prefix, e.g. 2e1e557c_caddy-dns01 (see system_overview)');

const relArg = z
  .string()
  .describe('Path relative to the add-on\'s config dir, e.g. global.d/site.caddy');

const restartArgs = {
  log_lines: z.number().int().min(1).max(1000).default(40),
  settle_seconds: z
    .number()
    .int()
    .min(0)
    .max(120)
    .default(5)
    .describe('Seconds to wait after the restart before reading state and logs'),
};

interface AddonSummary {
  slug: string;
  name: string;
  state: string;
  version: string;
  version_latest: string;
  update_available: boolean;
  repository: string;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    e => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    },
  );
}

export function registerHaTools(server: McpServer, config: Config): void {
  /** /addon_configs/<slug>, which must already exist (created by Supervisor for add-ons that map it). */
  async function addonDir(slug: string): Promise<string> {
    const dir = join(config.addonConfigsDir, slug);
    if (!(await exists(dir))) {
      throw new PathError(
        `${dir} does not exist: add-on ${slug} is not installed, or doesn't map an addon_config dir ` +
          '(system_overview lists which add-ons have one)',
      );
    }
    return dir;
  }

  /**
   * Restart, give the add-on `settleSeconds` to log its startup, then report its state and
   * what it has logged since this start (not the previous run's shutdown).
   */
  async function restartAndCheck(slug: string, logLines: number, settleSeconds: number) {
    audit('addon_restart', { slug });
    await supervisorData('POST', `/addons/${slug}/restart`);
    await Bun.sleep(settleSeconds * 1000);
    const info = await supervisorData<{ state: string; version: string }>('GET', `/addons/${slug}/info`);
    return { slug, state: info.state, version: info.version, logs: await addonLogsSinceStart(slug, logLines) };
  }

  server.registerTool(
    'system_overview',
    {
      description:
        'One-call snapshot of the Home Assistant host: Core, Supervisor and OS versions and pending ' +
        'updates, disk usage, health, and every add-on (slug, state, version, update available) with the ' +
        'path of its config dir under /addon_configs when it has one. Start here to find add-on slugs.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [info, host, core, os, sup, addons] = await Promise.all([
        supervisorData('GET', '/info'),
        supervisorData('GET', '/host/info'),
        supervisorData('GET', '/core/info'),
        supervisorData('GET', '/os/info'),
        supervisorData('GET', '/supervisor/info'),
        supervisorData<{ addons: AddonSummary[] }>('GET', '/addons'),
      ]);
      const withDirs = await Promise.all(
        addons.addons.map(async a => {
          const dir = join(config.addonConfigsDir, a.slug);
          return {
            slug: a.slug,
            name: a.name,
            state: a.state,
            version: a.version,
            update_available: a.update_available,
            ...(a.update_available ? { version_latest: a.version_latest } : {}),
            config_dir: (await exists(dir)) ? dir : null,
          };
        }),
      );
      return result({
        hostname: host.hostname,
        machine: info.machine,
        arch: info.arch,
        supported: info.supported,
        healthy: info.healthy,
        core: { version: core.version, version_latest: core.version_latest, update_available: core.update_available },
        supervisor: {
          version: sup.version,
          version_latest: sup.version_latest,
          update_available: sup.update_available,
          channel: sup.channel,
        },
        os: { version: os.version, version_latest: os.version_latest, update_available: os.update_available, board: os.board },
        disk: { total_gb: host.disk_total, used_gb: host.disk_used, free_gb: host.disk_free },
        addons: withDirs,
      });
    },
  );

  server.registerTool(
    'addon_list_files',
    {
      description: "List an add-on's config dir (/addon_configs/<slug>), or a subdirectory of it.",
      inputSchema: {
        slug: slugArg,
        path: relArg.default(''),
        recursive: z.boolean().default(true),
        max_entries: z.number().int().min(1).max(20000).default(2000),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ slug, path, ...opts }) => {
      const dir = await addonDir(slug);
      return result(await listDirAt(join(dir, path), [dir], opts));
    },
  );

  server.registerTool(
    'addon_read_file',
    {
      description: "Read a file from an add-on's config dir (/addon_configs/<slug>).",
      inputSchema: { slug: slugArg, path: relArg, ...fileArgs },
      annotations: { readOnlyHint: true },
    },
    async ({ slug, path, ...opts }) => {
      const dir = await addonDir(slug);
      return result(await readFileAt(join(dir, path), [dir], opts));
    },
  );

  server.registerTool(
    'addon_write_file',
    {
      description:
        "Write a file in an add-on's config dir (/addon_configs/<slug>), atomically. With restart=true, " +
        'also restarts the add-on and returns its state and what it logged since starting, so one call ' +
        'applies and verifies a config change. Use if_sha256 (from addon_read_file) to avoid clobbering ' +
        'concurrent edits.',
      inputSchema: {
        slug: slugArg,
        path: relArg,
        ...writeArgs,
        restart: z.boolean().default(false),
        ...restartArgs,
      },
      annotations: { destructiveHint: true },
    },
    async ({ slug, path, restart, log_lines, settle_seconds, ...opts }) => {
      const dir = await addonDir(slug);
      const written = await writeFileAt(join(dir, path), [dir], opts);
      return result({
        written,
        ...(restart ? { restart: await restartAndCheck(slug, log_lines, settle_seconds) } : {}),
      });
    },
  );

  server.registerTool(
    'addon_restart',
    {
      description: 'Restart an add-on, then return its state and what it has logged since this start.',
      inputSchema: { slug: slugArg, ...restartArgs },
      annotations: { destructiveHint: true },
    },
    async ({ slug, log_lines, settle_seconds }) => result(await restartAndCheck(slug, log_lines, settle_seconds)),
  );

  server.registerTool(
    'addon_logs',
    {
      description: "The latest lines of an add-on's log.",
      inputSchema: { slug: slugArg, lines: z.number().int().min(1).max(5000).default(100) },
      annotations: { readOnlyHint: true },
    },
    async ({ slug, lines }) => result({ slug, logs: await addonLogs(slug, lines) }),
  );

  server.registerTool(
    'core_check_config',
    {
      description:
        "Validate Home Assistant Core's configuration (what `ha core check` does). Run it after editing " +
        'anything under /config and before restarting Core. Throws with the error text if the config is invalid.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      await supervisorData('POST', '/core/check');
      return result({ valid: true });
    },
  );
}
