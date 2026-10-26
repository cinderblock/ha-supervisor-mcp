// Path guard for the file tools: every path must resolve, symlinks included,
// to somewhere inside one of the configured roots.

import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class PathError extends Error {}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Realpath of `p`, or of its nearest existing ancestor joined with the rest. */
async function realpathOrAncestor(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = await realpath(cur);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = dirname(cur);
      if (parent === cur) throw e;
      tail.push(cur.slice(parent.length).replace(/^[\\/]+/, ''));
      cur = parent;
    }
  }
}

export interface Resolved {
  /** The real, symlink-free path that operations should use. */
  path: string;
  /** The (real) root it lives under. */
  root: string;
}

/**
 * Resolve `input` against `roots`. Throws PathError if the path is relative,
 * or if it (after following symlinks) leaves every root.
 */
export async function resolveAllowed(input: string, roots: readonly string[]): Promise<Resolved> {
  if (!isAbsolute(input)) throw new PathError(`path must be absolute: ${input}`);
  const real = await realpathOrAncestor(resolve(input));
  for (const root of roots) {
    const realRoot = await realpath(root);
    if (within(realRoot, real)) return { path: real, root: realRoot };
  }
  throw new PathError(`path is outside the allowed roots (${roots.join(', ')}): ${input}`);
}

export function isRoot(r: Resolved): boolean {
  return r.path === r.root || r.path + sep === r.root;
}
