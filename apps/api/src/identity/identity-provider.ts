import { randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** Identity asserted by the provider after verification. */
export interface VerifiedIdentity {
  readonly provider: 'google.com' | 'dev-local';
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
}

/** What the identity provider returns when a sign-in starts. */
export interface SignInStart {
  /** Where to send the user's browser. */
  readonly authorizationUrl: string;
  /** Opaque provider session to keep with the login attempt (session-fixation defence). */
  readonly providerSessionId: string;
}

/** Port for the browser sign-in provider; the rest of identity is provider-agnostic. */
export interface IdentityProvider {
  begin(callbackUrl: string): Promise<SignInStart>;
  /** @param callbackUrl the full URL the browser returned to, including its query string */
  complete(
    callbackUrl: string,
    providerSessionId: string,
  ): Promise<VerifiedIdentity>;
}

/** Sign-in was refused or could not be verified; details stay out of client responses. */
export class IdentityVerificationError extends Error {
  constructor(readonly reason: string) {
    super(`Identity verification failed: ${reason}`);
    this.name = 'IdentityVerificationError';
  }
}

const identityToolkit = 'https://identitytoolkit.googleapis.com/v1';
const secureTokenJwks =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const requestTimeoutMs = 10_000;

function stringField(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      // Header rather than query string keeps the key out of URLs and access logs.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    throw new IdentityVerificationError('identity service unreachable');
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (
    !response.ok ||
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    // Google's error code (e.g. OPERATION_NOT_ALLOWED) is safe to log; free text is not.
    const error =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? payload.error
        : undefined;
    const message =
      typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : '';
    const code = /^[A-Z_]{3,60}/.exec(message)?.[0];
    throw new IdentityVerificationError(
      `identity service returned ${response.status}${code ? ` ${code}` : ''}`,
    );
  }
  return payload as Record<string, unknown>;
}

/**
 * Google sign-in through Google Identity Platform's REST API (the flow the Firebase
 * redirect SDK uses). The Google OAuth client and its secret are configured inside
 * Identity Platform; this adapter holds only the project's API key, an identifier.
 */
export class IdentityPlatformProvider implements IdentityProvider {
  private readonly keys: JWTVerifyGetKey;

  constructor(
    private readonly apiKey: string,
    private readonly projectId: string,
    keys?: JWTVerifyGetKey,
  ) {
    this.keys = keys ?? createRemoteJWKSet(new URL(secureTokenJwks));
  }

  async begin(callbackUrl: string): Promise<SignInStart> {
    const payload = await postJson(
      `${identityToolkit}/accounts:createAuthUri`,
      this.apiKey,
      {
        providerId: 'google.com',
        continueUri: callbackUrl,
        authFlowType: 'CODE_FLOW',
        oauthScope: 'openid email profile',
      },
    );
    const authorizationUrl = stringField(payload, 'authUri');
    const providerSessionId = stringField(payload, 'sessionId');
    if (!authorizationUrl?.startsWith('https://') || !providerSessionId)
      throw new IdentityVerificationError('incomplete createAuthUri response');
    return { authorizationUrl, providerSessionId };
  }

  async complete(
    callbackUrl: string,
    providerSessionId: string,
  ): Promise<VerifiedIdentity> {
    const payload = await postJson(
      `${identityToolkit}/accounts:signInWithIdp`,
      this.apiKey,
      {
        requestUri: callbackUrl,
        sessionId: providerSessionId,
        returnSecureToken: true,
        returnIdpCredential: false,
      },
    );
    const idToken = stringField(payload, 'idToken');
    if (!idToken)
      throw new IdentityVerificationError('no Identity Platform token');
    return this.verifyIdToken(idToken);
  }

  /** Verifies an Identity Platform ID token: signature, issuer, audience, expiry and provider. */
  async verifyIdToken(idToken: string): Promise<VerifiedIdentity> {
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(idToken, this.keys, {
        issuer: `https://securetoken.google.com/${this.projectId}`,
        audience: this.projectId,
        algorithms: ['RS256'],
        clockTolerance: 60,
      }));
    } catch {
      throw new IdentityVerificationError('invalid Identity Platform token');
    }
    const firebase = claims.firebase;
    const signInProvider =
      typeof firebase === 'object' &&
      firebase !== null &&
      'sign_in_provider' in firebase
        ? firebase.sign_in_provider
        : undefined;
    const subject = stringField(claims, 'sub');
    const email = stringField(claims, 'email');
    if (
      signInProvider !== 'google.com' ||
      !subject ||
      subject.length > 128 ||
      !email
    )
      throw new IdentityVerificationError('unexpected token claims');
    if (claims.email_verified !== true)
      throw new IdentityVerificationError('email not verified');
    const name = stringField(claims, 'name');
    return {
      provider: 'google.com',
      subject,
      email: email.toLowerCase(),
      emailVerified: true,
      displayName: name ? name.slice(0, 200) : null,
    };
  }
}

/**
 * Local-development stand-in for Google: a confirmation page on the API itself.
 * Configuration refuses it in production (see config.ts).
 */
export class DevIdentityProvider implements IdentityProvider {
  constructor(private readonly publicBaseUrl: URL) {}

  begin(): Promise<SignInStart> {
    const providerSessionId = randomBytes(16).toString('base64url');
    const url = new URL('/v1/auth/dev/authorize', this.publicBaseUrl);
    url.searchParams.set('session', providerSessionId);
    return Promise.resolve({ authorizationUrl: url.href, providerSessionId });
  }

  complete(
    callbackUrl: string,
    providerSessionId: string,
  ): Promise<VerifiedIdentity> {
    const url = new URL(callbackUrl);
    const email = url.searchParams.get('email')?.trim().toLowerCase() ?? '';
    if (url.searchParams.get('dev_session') !== providerSessionId)
      return Promise.reject(
        new IdentityVerificationError('dev session mismatch'),
      );
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email))
      return Promise.reject(new IdentityVerificationError('invalid dev email'));
    return Promise.resolve({
      provider: 'dev-local',
      subject: `dev:${email}`,
      email,
      emailVerified: true,
      displayName: email.split('@')[0] ?? null,
    });
  }
}
