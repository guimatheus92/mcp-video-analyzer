import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { envFlag } from './env.js';

/**
 * Why a destination was refused. `metadata` is a strict subset of `private` in
 * network terms but a separate verdict here, because it is the one category the
 * operator opt-in must NOT unlock: there is no legitimate "analyze the video
 * hosted on the instance metadata service".
 */
export type BlockedReason = 'metadata' | 'private';

/** True when the operator has opted into reaching private/loopback addresses. */
export function allowPrivateUrls(): boolean {
  return envFlag(process.env.MCP_ALLOW_PRIVATE_URLS);
}

/**
 * Cloud metadata endpoints, blocked unconditionally.
 *
 * These are the credential-bearing endpoints: AWS/GCP IMDS, Azure WireServer,
 * Alibaba, and the IPv6 IMDS. `169.254.169.254` is already inside link-local,
 * but listing it explicitly is what lets the opt-in keep blocking it.
 */
const METADATA_ADDRESSES: readonly string[] = [
  '169.254.169.254/32',
  '168.63.129.16/32',
  '100.100.100.200/32',
  'fd00:ec2::254/128',
];

interface Cidr {
  /** Network address as a bigint, already masked. */
  readonly network: bigint;
  /** Number of leading bits that must match. */
  readonly prefix: number;
  /** 4 for IPv4 ranges, 6 for IPv6 ranges. */
  readonly family: 4 | 6;
}

/**
 * Ranges that are never a legitimate video host.
 *
 * Deliberately wider than the RFC1918 + loopback + link-local set the report
 * suggested. Gitea's GHSA-2r5c-gw76-rh3w is CVSS 9.6 for a block list that
 * stopped exactly there: Go's `net.IP.IsPrivate()` covers only RFC1918 and
 * RFC4193, which leaves CGNAT, the Azure WireServer address, and every IPv6
 * transition mechanism reachable. `64:ff9b::a9fe:a9fe` reaches the AWS IMDS
 * through NAT64, so the IPv6 rows are not theoretical.
 *
 * Only ever grows. Removing a row re-opens a documented bypass.
 */
const BLOCKED_RANGES: readonly string[] = [
  // IPv4
  '0.0.0.0/8', // "this host on this network" — 0.0.0.0 reaches loopback on Linux
  '10.0.0.0/8', // RFC1918
  '100.64.0.0/10', // RFC6598 CGNAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, incl. cloud metadata
  '172.16.0.0/12', // RFC1918
  '172.32.0.0/11', // widely used internally despite not being RFC1918
  '192.0.0.0/24', // IETF protocol assignments
  '192.168.0.0/16', // RFC1918
  '198.18.0.0/15', // RFC2544 benchmarking
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, incl. 255.255.255.255
  // IPv6
  '::/128', // unspecified
  '::1/128', // loopback
  '64:ff9b::/96', // RFC6052 NAT64 — embeds IPv4, reaches IMDS
  '2001::/32', // RFC4380 Teredo
  '2001:db8::/32', // RFC3849 documentation
  '2002::/16', // RFC3056 6to4
  'fc00::/7', // RFC4193 unique local
  'fe80::/10', // link-local
];

/**
 * Parse an IP literal to a bigint plus its family, or null if it isn't one.
 *
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) collapses to its IPv4 form first — it
 * is the canonicalization bypass mcp-searxng's CVE-2026-54689 turned on, and
 * comparing it as a v6 address would miss every v4 row above.
 */
function parseIp(value: string): { bits: bigint; family: 4 | 6 } | null {
  const family = isIP(value);

  if (family === 4) {
    const octets = value.split('.');
    let bits = 0n;
    for (const octet of octets) {
      bits = (bits << 8n) | BigInt(Number(octet));
    }
    return { bits, family: 4 };
  }

  if (family !== 6) return null;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) {
    return parseIp(mapped[1]);
  }

  return { bits: expandIpv6(value), family: 6 };
}

/** Expand an IPv6 literal (including `::` and trailing dotted-quad) to 128 bits. */
function expandIpv6(value: string): bigint {
  let head = value;

  // A trailing dotted-quad (`64:ff9b::192.0.2.1`) becomes two hextets.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(head);
  if (dotted) {
    const parsed = parseIp(dotted[1]);
    /* c8 ignore next -- isIP already validated the dotted-quad shape */
    if (!parsed) return 0n;
    const v4 = parsed.bits;
    head =
      head.slice(0, dotted.index) + `${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }

  const [left, right] = head.split('::');
  const leftParts = left ? left.split(':').filter(Boolean) : [];
  const rightParts = right ? right.split(':').filter(Boolean) : [];
  const missing = 8 - leftParts.length - rightParts.length;
  const parts = [
    ...leftParts,
    ...(head.includes('::') ? Array<string>(missing).fill('0') : []),
    ...rightParts,
  ];

  let bits = 0n;
  for (const part of parts) {
    bits = (bits << 16n) | BigInt(parseInt(part, 16));
  }
  return bits;
}

function parseCidr(cidr: string): Cidr {
  const [address, prefixText] = cidr.split('/');
  const parsed = parseIp(address);
  /* c8 ignore next -- BLOCKED_RANGES is a literal table, guarded by its own test */
  if (!parsed) throw new Error(`Unparsable blocked range: ${cidr}`);
  const prefix = Number(prefixText);
  const width = parsed.family === 4 ? 32 : 128;
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix);
  return { network: parsed.bits & mask, prefix, family: parsed.family };
}

const PARSED_METADATA: readonly Cidr[] = METADATA_ADDRESSES.map(parseCidr);
const PARSED_RANGES: readonly Cidr[] = BLOCKED_RANGES.map(parseCidr);

function inAnyRange(parsed: { bits: bigint; family: 4 | 6 }, ranges: readonly Cidr[]): boolean {
  const width = parsed.family === 4 ? 32 : 128;
  return ranges.some((range) => {
    if (range.family !== parsed.family) return false;
    const mask = ((1n << BigInt(range.prefix)) - 1n) << BigInt(width - range.prefix);
    return (parsed.bits & mask) === range.network;
  });
}

/**
 * Classify an IP address literal. Returns null for a public address, and for
 * anything that isn't an IP at all (hostnames are the caller's problem —
 * `assertPublicUrl` resolves them first).
 *
 * Matching is numeric, never string-wise: `fd00:0ec2:0:0:0:0:0:0254` and
 * `::ffff:169.254.169.254` are the same destinations as their canonical
 * spellings, and a string set would let either past the metadata verdict — the
 * one verdict the operator opt-in must not be able to unlock.
 */
export function isBlockedAddress(address: string): BlockedReason | null {
  const parsed = parseIp(address);
  if (!parsed) return null;

  if (inAnyRange(parsed, PARSED_METADATA)) return 'metadata';
  if (inAnyRange(parsed, PARSED_RANGES)) return 'private';

  return null;
}

/**
 * Classify a hostname WITHOUT resolving it — a synchronous check usable from
 * `detectPlatform`, which is on the hot path and must stay sync.
 *
 * Catches IP literals and the names that always mean "this machine". A hostname
 * that merely resolves to a private address passes here and is caught later by
 * `assertPublicUrl`.
 */
export function isBlockedHostLiteral(hostname: string): BlockedReason | null {
  // `new URL()` keeps IPv6 literals bracketed in `.hostname`.
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (bare === 'localhost' || bare.endsWith('.localhost')) return 'private';
  // mDNS names resolve on the local link only.
  if (bare.endsWith('.local')) return 'private';

  return isBlockedAddress(bare);
}

/** The one message shape both sinks and the source detector surface. */
export function blockedReasonMessage(reason: BlockedReason): string {
  return reason === 'metadata'
    ? 'That address is a cloud instance metadata endpoint, which this server never fetches.'
    : 'That address is on a private or loopback network. Set MCP_ALLOW_PRIVATE_URLS=1 to allow it.';
}

/**
 * Not exported: no caller needs `instanceof`, they surface `.message`. Keeping
 * it internal satisfies the repo's zero-unused-exports rule without inventing a
 * consumer for it.
 */
class BlockedDestinationError extends Error {
  constructor(readonly reason: BlockedReason) {
    super(blockedReasonMessage(reason));
    this.name = 'BlockedDestinationError';
  }
}

/**
 * Reject a URL whose destination is internal. Resolves DNS and checks EVERY
 * returned address, so a name with one public and one loopback record does not
 * slip through on record order.
 *
 * ponytail: check-then-connect, so DNS rebinding (a domain answering public at
 * lookup time and loopback at connect time) is still possible. Closing it needs
 * a connection-time hook — `undici`'s `Agent({ connect: { lookup } })` — which
 * would promote undici from a transitive dep to a direct one. Do that if this
 * server ever runs somewhere multi-tenant.
 */
export async function assertPublicUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('That is not a valid URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs can be fetched.');
  }

  const literal = isBlockedHostLiteral(parsed.hostname);
  if (literal && (literal === 'metadata' || !allowPrivateUrls())) {
    throw new BlockedDestinationError(literal);
  }

  // An IP literal is already decided — resolving it would be a no-op that can
  // still fail on a host with no resolver configured.
  if (isIP(parsed.hostname.replace(/^\[|\]$/g, ''))) return;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(parsed.hostname, { all: true });
  } catch {
    throw new Error('That hostname could not be resolved.');
  }

  for (const { address } of addresses) {
    const reason = isBlockedAddress(address);
    if (reason && (reason === 'metadata' || !allowPrivateUrls())) {
      throw new BlockedDestinationError(reason);
    }
  }
}

/** Exported for the drift guard — a block list that silently emptied would pass every test. */
export const BLOCKED_RANGE_COUNT = BLOCKED_RANGES.length;
