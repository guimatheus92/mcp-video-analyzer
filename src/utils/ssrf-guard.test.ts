import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLOCKED_RANGE_COUNT,
  assertPublicUrl,
  isBlockedAddress,
  isBlockedHostLiteral,
} from './ssrf-guard.js';

// A failing assertion before an inline unstub would otherwise leave the opt-in
// set for every later test in this file — which is how a single real failure
// cascades into unrelated ones.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isBlockedAddress', () => {
  // Every row here is a destination some real advisory reached. The bypass
  // rows matter most: they are the ones a "block RFC1918 + loopback" list
  // passes, which is what Gitea's GHSA-2r5c-gw76-rh3w scored 9.6 for.
  it.each([
    // the reporter's own PoC
    ['127.0.0.1', 'private'],
    ['127.1.2.3', 'private'],
    // RFC1918
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['192.168.1.5', 'private'],
    // mcp-searxng CVE-2026-54689: 0.0.0.0 reaches loopback-bound services
    ['0.0.0.0', 'private'],
    // Gitea GHSA-2r5c-gw76-rh3w: ranges Go's net.IP.IsPrivate() misses
    ['100.64.0.1', 'private'], // CGNAT
    ['172.32.0.1', 'private'],
    ['198.18.0.1', 'private'],
    ['192.0.0.1', 'private'],
    ['255.255.255.255', 'private'],
    ['224.0.0.1', 'private'],
    // metadata — a separate verdict, because the opt-in must not unlock it
    ['169.254.169.254', 'metadata'],
    ['168.63.129.16', 'metadata'], // Azure WireServer
    ['100.100.100.200', 'metadata'], // Alibaba
    ['169.254.1.1', 'private'], // link-local but not metadata
    // IPv6
    ['::1', 'private'],
    ['::', 'private'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fe80::1', 'private'],
    ['2002::1', 'private'], // 6to4
    ['2001::1', 'private'], // Teredo
    ['2001:db8::1', 'private'],
    ['fd00:ec2::254', 'metadata'],
    // NAT64 reaching the AWS IMDS — 169.254.169.254 embedded as IPv6
    ['64:ff9b::a9fe:a9fe', 'private'],
    // mcp-searxng CVE-2026-54689: IPv4-mapped IPv6 canonicalization bypass
    ['::ffff:127.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'metadata'],
  ])('blocks %s as %s', (address, reason) => {
    expect(isBlockedAddress(address)).toBe(reason);
  });

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['93.184.216.34'],
    ['172.15.0.1'], // just below the RFC1918 block
    ['172.64.0.1'], // just above 172.32.0.0/11, which ends at 172.63.255.255
    ['100.63.255.255'], // just below CGNAT
    ['100.128.0.1'], // just above CGNAT
    ['2606:4700::1111'],
  ])('allows the public address %s', (address) => {
    expect(isBlockedAddress(address)).toBeNull();
  });

  it('returns null for things that are not IP addresses', () => {
    expect(isBlockedAddress('example.com')).toBeNull();
    expect(isBlockedAddress('')).toBeNull();
    expect(isBlockedAddress('999.999.999.999')).toBeNull();
  });

  it('alternate spellings of a metadata address are still metadata', () => {
    // A string-keyed set would miss both of these while the canonical form hit.
    expect(isBlockedAddress('fd00:0ec2:0000:0000:0000:0000:0000:0254')).toBe('metadata');
    expect(isBlockedAddress('::ffff:168.63.129.16')).toBe('metadata');
  });

  it('scanned a non-empty range table', () => {
    // Guards the "test that cannot fail" case: if BLOCKED_RANGES were emptied,
    // every row above would return null and only this assertion would notice.
    expect(BLOCKED_RANGE_COUNT).toBeGreaterThanOrEqual(20);
  });
});

describe('isBlockedHostLiteral', () => {
  it.each([
    ['localhost', 'private'],
    ['LOCALHOST', 'private'],
    ['api.localhost', 'private'],
    ['nas.local', 'private'], // mDNS resolves on the local link only
    ['127.0.0.1', 'private'],
    ['[::1]', 'private'], // new URL() keeps IPv6 hostnames bracketed
    ['169.254.169.254', 'metadata'],
  ])('blocks the host literal %s', (hostname, reason) => {
    expect(isBlockedHostLiteral(hostname)).toBe(reason);
  });

  it('lets a public hostname through — resolution is assertPublicUrl’s job', () => {
    expect(isBlockedHostLiteral('example.com')).toBeNull();
    expect(isBlockedHostLiteral('videos.cdn.example.com')).toBeNull();
  });
});

describe('assertPublicUrl', () => {
  it('rejects the reporter’s PoC URL', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:8931/x.mp4')).rejects.toThrow(
      /private or loopback/i,
    );
  });

  it('names the env var in the private-address message', async () => {
    // The message is the only route a LAN user has to the opt-in.
    await expect(assertPublicUrl('http://192.168.1.5/clip.mp4')).rejects.toThrow(
      /MCP_ALLOW_PRIVATE_URLS=1/,
    );
  });

  it.each(['ftp://example.com/x.mp4', 'data:text/plain,x.mp4', 'file:///etc/passwd.mp4'])(
    'rejects the non-http scheme in %s',
    async (url) => {
      await expect(assertPublicUrl(url)).rejects.toThrow(/only http/i);
    },
  );

  it('rejects a malformed URL', async () => {
    await expect(assertPublicUrl('not-a-url')).rejects.toThrow(/valid URL/i);
  });

  it('allows a public IP literal without resolving it', async () => {
    await expect(assertPublicUrl('http://93.184.216.34/video.mp4')).resolves.toBeUndefined();
  });

  it('blocks a hostname that RESOLVES to a private address', async () => {
    // The literal check passes here — this is the case only DNS resolution
    // catches, and the one mcp-searxng's GHSA-mrvx-jmjw-vggc was filed for.
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn().mockResolvedValue([{ address: '10.1.2.3', family: 4 }]),
    }));
    vi.resetModules();
    const { assertPublicUrl: guard } = await import('./ssrf-guard.js');

    await expect(guard('http://internal.example.com/x.mp4')).rejects.toThrow(
      /private or loopback/i,
    );

    vi.doUnmock('node:dns/promises');
    vi.resetModules();
  });

  it('blocks when ANY resolved address is private, not just the first', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn().mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    }));
    vi.resetModules();
    const { assertPublicUrl: guard } = await import('./ssrf-guard.js');

    await expect(guard('http://split-horizon.example.com/x.mp4')).rejects.toThrow(
      /private or loopback/i,
    );

    vi.doUnmock('node:dns/promises');
    vi.resetModules();
  });

  it('rejects a hostname that cannot be resolved', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn().mockRejectedValue(new Error('ENOTFOUND')),
    }));
    vi.resetModules();
    const { assertPublicUrl: guard } = await import('./ssrf-guard.js');

    await expect(guard('http://nope.invalid/x.mp4')).rejects.toThrow(/could not be resolved/i);

    vi.doUnmock('node:dns/promises');
    vi.resetModules();
  });
});

describe('MCP_ALLOW_PRIVATE_URLS opt-in', () => {
  it('allows a private address when set', async () => {
    // Without this the whole suite would still pass with the opt-in dead —
    // every other assertion here is a rejection.
    vi.stubEnv('MCP_ALLOW_PRIVATE_URLS', '1');
    await expect(assertPublicUrl('http://192.168.1.5/clip.mp4')).resolves.toBeUndefined();
    await expect(assertPublicUrl('http://127.0.0.1:8080/clip.mp4')).resolves.toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('still blocks cloud metadata when set', async () => {
    vi.stubEnv('MCP_ALLOW_PRIVATE_URLS', '1');
    await expect(assertPublicUrl('http://169.254.169.254/latest.mp4')).rejects.toThrow(
      /metadata endpoint/i,
    );
    await expect(assertPublicUrl('http://168.63.129.16/x.mp4')).rejects.toThrow(
      /metadata endpoint/i,
    );
    vi.unstubAllEnvs();
  });

  it('still rejects a non-http scheme when set', async () => {
    vi.stubEnv('MCP_ALLOW_PRIVATE_URLS', '1');
    await expect(assertPublicUrl('file:///etc/passwd.mp4')).rejects.toThrow(/only http/i);
    vi.unstubAllEnvs();
  });
});
