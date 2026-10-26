import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipAllowed, parseCidr, tokenMatches } from '../src/auth.ts';
import { isRoot, PathError, resolveAllowed } from '../src/paths.ts';
import pkg from '../package.json' with { type: 'json' };

describe('ipAllowed', () => {
  const cidrs = ['10.0.0.0/8', '192.168.1.0/24', '127.0.0.1', 'fc00::/7'].map(parseCidr);
  test.each([
    ['10.255.0.77', true],
    ['11.0.0.1', false],
    ['192.168.1.200', true],
    ['192.168.2.1', false],
    ['127.0.0.1', true],
    ['127.0.0.2', false],
    ['::ffff:10.1.2.3', true],
    ['::ffff:8.8.8.8', false],
    ['fd12:3456::1', true],
    ['2001:db8::1', false],
    ['::1', false],
  ])('%s → %p', (ip, ok) => expect(ipAllowed(ip, cidrs)).toBe(ok));

  test('rejects malformed CIDRs', () => {
    expect(() => parseCidr('10.0.0.0/33')).toThrow();
    expect(() => parseCidr('nonsense/8')).toThrow();
  });
});

describe('tokenMatches', () => {
  test('exact bearer only', () => {
    expect(tokenMatches('Bearer abc', 'abc')).toBe(true);
    expect(tokenMatches('Bearer abd', 'abc')).toBe(false);
    expect(tokenMatches('Bearer ab', 'abc')).toBe(false);
    expect(tokenMatches('abc', 'abc')).toBe(false);
    expect(tokenMatches(null, 'abc')).toBe(false);
  });
});

describe('resolveAllowed', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ha-supervisor-mcp-paths-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'secret'), 'x');
  // Directory symlinks need admin rights on Windows; skip that case there.
  const canSymlink = await symlink(outside, join(root, 'escape'), 'junction').then(
    () => true,
    () => false,
  );

  test('inside a root, existing and not yet existing', async () => {
    expect((await resolveAllowed(join(root, 'sub'), [root])).path).toEndWith('sub');
    expect((await resolveAllowed(join(root, 'new', 'deeper.txt'), [root])).path).toEndWith('deeper.txt');
  });

  test('the root itself is allowed and flagged', async () => {
    expect(isRoot(await resolveAllowed(root, [root]))).toBe(true);
  });

  test('relative and dot-dot escapes are refused', async () => {
    await expect(resolveAllowed('sub/x', [root])).rejects.toBeInstanceOf(PathError);
    await expect(resolveAllowed(join(root, '..', 'outside', 'secret'), [root])).rejects.toBeInstanceOf(PathError);
  });

  test.if(canSymlink)('symlink escapes are refused', async () => {
    await expect(resolveAllowed(join(root, 'escape', 'secret'), [root])).rejects.toBeInstanceOf(PathError);
  });
});

test('package.json and config.yaml versions agree', async () => {
  const yaml = await readFile(join(import.meta.dir, '..', 'config.yaml'), 'utf8');
  expect(yaml.match(/^version: "([^"]+)"$/m)?.[1]).toBe(pkg.version);
});
