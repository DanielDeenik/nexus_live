/**
 * Cryptographic utilities for hashing and JWT
 */

/**
 * Hash a token using SHA-256
 */
export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/**
 * Verify a token against its hash
 */
export async function verifyTokenHash(
  token: string,
  hash: string
): Promise<boolean> {
  const tokenHash = await hashToken(token);
  return tokenHash === hash;
}

/**
 * Generate a random token
 */
export function generateToken(length: number = 32): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    token += chars[array[i] % chars.length];
  }
  return token;
}

/**
 * Sign JWT payload
 */
export async function signJWT(
  payload: Record<string, unknown>,
  secret: string,
  expiryHours: number = 24
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    ...payload,
    iat: now,
    exp: now + expiryHours * 3600,
  };

  const headerEncoded = btoa(JSON.stringify(header))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  const claimsEncoded = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  const message = `${headerEncoded}.${claimsEncoded}`;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const signatureArray = Array.from(new Uint8Array(signature));
  const signatureEncoded = btoa(String.fromCharCode(...signatureArray))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${message}.${signatureEncoded}`;
}

/**
 * Verify and decode JWT
 */
export async function verifyJWT(
  token: string,
  secret: string
): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerEncoded, claimsEncoded, signatureEncoded] = parts;

    // Verify signature
    const message = `${headerEncoded}.${claimsEncoded}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    // Decode signature
    const signaturePadded = signatureEncoded.padEnd(
      signatureEncoded.length + ((4 - (signatureEncoded.length % 4)) % 4),
      '='
    );
    const signatureBinary = atob(
      signaturePadded.replace(/-/g, '+').replace(/_/g, '/')
    );
    const signatureArray = new Uint8Array(signatureBinary.length);
    for (let i = 0; i < signatureBinary.length; i++) {
      signatureArray[i] = signatureBinary.charCodeAt(i);
    }

    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureArray,
      encoder.encode(message)
    );

    if (!isValid) return null;

    // Decode claims
    const claimsPadded = claimsEncoded.padEnd(
      claimsEncoded.length + ((4 - (claimsEncoded.length % 4)) % 4),
      '='
    );
    const claimsJson = atob(claimsPadded.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(claimsJson);

    // Check expiry
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return claims;
  } catch (error) {
    return null;
  }
}
