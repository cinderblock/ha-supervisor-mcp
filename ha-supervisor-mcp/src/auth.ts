// Bearer-token check and source-address allowlist.

import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export function tokenMatches(header: string | null, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function v4ToBigInt(ip: string): bigint {
  return ip.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

function v6ToBigInt(ip: string): bigint {
  // Expand an embedded dotted IPv4 tail (e.g. ::ffff:10.0.0.1) into two hextets.
  const dotted = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = v4ToBigInt(dotted[2]!);
    ip = `${dotted[1]}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) throw new Error(`bad IPv6 address: ${ip}`);
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

interface Parsed {
  family: 4 | 6;
  value: bigint;
}

function parseIp(ip: string): Parsed {
  const family = isIP(ip);
  if (family === 4) return { family: 4, value: v4ToBigInt(ip) };
  if (family === 6) {
    const v6 = v6ToBigInt(ip);
    // IPv4-mapped (::ffff:a.b.c.d) compares as IPv4.
    if (v6 >> 32n === 0xffffn) return { family: 4, value: v6 & 0xffffffffn };
    return { family: 6, value: v6 };
  }
  throw new Error(`not an IP address: ${ip}`);
}

export interface Cidr {
  family: 4 | 6;
  network: bigint;
  bits: number;
}

export function parseCidr(cidr: string): Cidr {
  const [addr, bitsStr] = cidr.split('/');
  const { family, value } = parseIp(addr!);
  const width = family === 4 ? 32 : 128;
  const bits = bitsStr === undefined ? width : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) throw new Error(`bad CIDR prefix: ${cidr}`);
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
  return { family, network: value & mask, bits };
}

export function ipAllowed(ip: string, cidrs: readonly Cidr[]): boolean {
  const { family, value } = parseIp(ip);
  const width = family === 4 ? 32 : 128;
  return cidrs.some(c => {
    if (c.family !== family) return false;
    const mask = ((1n << BigInt(c.bits)) - 1n) << BigInt(width - c.bits);
    return (value & mask) === c.network;
  });
}
