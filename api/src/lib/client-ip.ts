/**
 * @fileoverview The guest's IP address. Behind CloudFront, API Gateway's sourceIp is a CloudFront
 * edge server, so a CloudFront Function on /api/* adds x-viewer-ip (the real viewer IP) plus a
 * shared secret x-origin-verify. The header is trusted only when the secret matches: requests that
 * bypass CloudFront (the public execute-api URL) could otherwise forge it, so they get their TCP
 * address.
 */
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/** The address per-IP limits apply to, and whether the request provably came via CloudFront. */
export interface ClientIp {
  ip: string;
  viaCloudFront: boolean;
}

/** Returns the guest's IP: x-viewer-ip when the origin secret matches, else the TCP source. */
export function clientIp(
  headers: Record<string, string | undefined> | undefined,
  sourceIp: string,
  originSecret: string,
): ClientIp {
  const presented = headers?.['x-origin-verify'] ?? '';
  const viaCloudFront =
    originSecret.length > 0 &&
    presented.length === originSecret.length &&
    timingSafeEqual(Buffer.from(presented), Buffer.from(originSecret));
  const viewerIp = headers?.['x-viewer-ip'] ?? '';
  if (viaCloudFront && isIP(viewerIp)) return { ip: viewerIp, viaCloudFront };
  return { ip: sourceIp, viaCloudFront };
}

/**
 * The unit a per-IP limit applies to: the address for IPv4, the /64 network for IPv6 (one home or
 * phone typically owns a whole /64, so per-address limits are trivially bypassed on IPv6).
 */
export function ipBucket(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const zeros = ip.includes('::') ? 8 - headParts.length - tailParts.length : 0;
  const full = [...headParts, ...Array(zeros).fill('0'), ...tailParts];
  return `${full
    .slice(0, 4)
    .map((g) => g.padStart(4, '0'))
    .join(':')}::/64`;
}
