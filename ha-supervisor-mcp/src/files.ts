// File operations shared by the generic file tools and the add-on config tools.
// Every path goes through resolveAllowed first.

import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isRoot, PathError, resolveAllowed } from './paths.ts';

/** One line per state-changing call, to the add-on log. */
export function audit(event: string, detail: Record<string, unknown>): void {
  console.log(`audit ${event} ${JSON.stringify(detail)}`);
}

const sha256 = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex');

export type Encoding = 'utf8' | 'base64';

export async function readFileAt(
  path: string,
  roots: readonly string[],
  opts: { encoding: Encoding; offset: number; max_bytes: number },
) {
  const { path: real } = await resolveAllowed(path, roots);
  const st = await stat(real);
  if (!st.isFile()) throw new PathError(`not a regular file: ${path}`);
  const buf = await readFile(real);
  const slice = buf.subarray(opts.offset, opts.offset + opts.max_bytes);
  return {
    path: real,
    size: st.size,
    sha256: sha256(buf),
    mtime: st.mtime.toISOString(),
    mode: (st.mode & 0o7777).toString(8),
    offset: opts.offset,
    returned_bytes: slice.length,
    truncated: opts.offset + slice.length < buf.length,
    encoding: opts.encoding,
    content: Buffer.from(slice).toString(opts.encoding),
  };
}

export async function writeFileAt(
  path: string,
  roots: readonly string[],
  opts: { content: string; encoding: Encoding; if_sha256?: string; mode?: string; create_dirs: boolean },
) {
  const { path: real } = await resolveAllowed(path, roots);
  let existingMode: number | undefined;
  let previous: string | null = null;
  try {
    const st = await stat(real);
    if (!st.isFile()) throw new PathError(`not a regular file: ${path}`);
    existingMode = st.mode & 0o7777;
    previous = sha256(await readFile(real));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (opts.if_sha256 !== undefined) {
    const expected = opts.if_sha256 === 'absent' ? null : opts.if_sha256.toLowerCase();
    if (expected !== previous) {
      throw new Error(`if_sha256 mismatch for ${path}: expected ${opts.if_sha256}, file is ${previous ?? 'absent'}`);
    }
  }
  if (opts.create_dirs) await mkdir(dirname(real), { recursive: true });
  const data = Buffer.from(opts.content, opts.encoding);
  const fileMode = opts.mode !== undefined ? parseInt(opts.mode, 8) : (existingMode ?? 0o644);
  const tmp = join(dirname(real), `.${basename(real)}.tmp-${randomBytes(4).toString('hex')}`);
  await writeFile(tmp, data, { mode: fileMode });
  await rename(tmp, real);
  const digest = sha256(data);
  audit('write_file', { path: real, bytes: data.length, sha256: digest, previous_sha256: previous });
  return { path: real, bytes: data.length, sha256: digest, previous_sha256: previous, mode: fileMode.toString(8) };
}

export async function listDirAt(
  path: string,
  roots: readonly string[],
  opts: { recursive: boolean; max_entries: number },
) {
  const { path: real } = await resolveAllowed(path, roots);
  const entries: Record<string, unknown>[] = [];
  let truncated = false;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      if (entries.length >= opts.max_entries) {
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
      if (opts.recursive && type === 'dir') await walk(full, `${prefix}${name}/`);
    }
  };
  await walk(real, '');
  return { path: real, count: entries.length, truncated, entries };
}

export async function deletePathAt(path: string, roots: readonly string[], opts: { recursive: boolean }) {
  if (isRoot(await resolveAllowed(path, roots))) throw new PathError(`refusing to delete a root: ${path}`);
  // Resolve only the parent, so a symlink is removed itself rather than its target.
  const parent = await resolveAllowed(dirname(path), roots);
  const target = join(parent.path, basename(path));
  const st = await lstat(target);
  if (st.isDirectory() && !opts.recursive) throw new Error(`${path} is a directory; pass recursive=true`);
  await rm(target, { recursive: opts.recursive });
  audit('delete_path', { path: target, recursive: opts.recursive });
  return { deleted: target };
}
