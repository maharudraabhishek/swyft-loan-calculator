import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random secret, base64url, with a prefix that makes leaked values recognisable. */
export function generateSecret(prefix: 'swa' | 'swr' | 'swc' | 'swb'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

/** Tokens are high-entropy, so a fast hash is sufficient; only hashes are stored. */
export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** RFC 7636 S256 code challenge. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
