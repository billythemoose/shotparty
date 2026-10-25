import { describe, expect, it } from 'vitest';
import { clientIp, ipBucket } from '../src/lib/client-ip.js';

const SECRET = 'a'.repeat(64);

describe('clientIp', () => {
  it('trusts x-viewer-ip when the CloudFront secret matches', () => {
    expect(
      clientIp({ 'x-origin-verify': SECRET, 'x-viewer-ip': '203.0.113.9' }, '130.176.1.1', SECRET),
    ).toEqual({ ip: '203.0.113.9', viaCloudFront: true });
  });

  it('ignores a forged x-viewer-ip on direct (non-CloudFront) calls', () => {
    expect(
      clientIp({ 'x-origin-verify': 'wrong', 'x-viewer-ip': '1.2.3.4' }, '198.51.100.7', SECRET),
    ).toEqual({ ip: '198.51.100.7', viaCloudFront: false });
    expect(clientIp({ 'x-viewer-ip': '1.2.3.4' }, '198.51.100.7', SECRET).ip).toBe('198.51.100.7');
  });

  it('falls back to the TCP address if the viewer header is not an IP', () => {
    expect(
      clientIp({ 'x-origin-verify': SECRET, 'x-viewer-ip': 'x; drop' }, '130.176.1.1', SECRET).ip,
    ).toBe('130.176.1.1');
  });

  it('never trusts anything when no secret is configured', () => {
    expect(clientIp({ 'x-origin-verify': '', 'x-viewer-ip': '1.2.3.4' }, '9.9.9.9', '').ip).toBe(
      '9.9.9.9',
    );
  });
});

describe('ipBucket', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['2001:db8:abcd:12:1:2:3:4', '2001:0db8:abcd:0012::/64'],
    ['2001:db8::1', '2001:0db8:0000:0000::/64'],
    ['2001:DB8:1:2::ff', '2001:0db8:0001:0002::/64'],
    ['::1', '0000:0000:0000:0000::/64'],
  ])('%s -> %s', (ip, bucket) => {
    expect(ipBucket(ip)).toBe(bucket);
  });

  it('puts two addresses from the same /64 in one bucket', () => {
    expect(ipBucket('2001:db8:1:2::a')).toBe(ipBucket('2001:db8:1:2:ffff:1:2:3'));
  });
});
