import type { TokenResponseDto, UserDto } from '@swyft/contracts';
import type { SessionPolicy } from '../config.js';
import type { Database, Principal } from '../db/database.js';
import {
  IdentityVerificationError,
  type IdentityProvider,
} from './identity-provider.js';
import { generateSecret, hashSecret, pkceChallenge } from './tokens.js';

const seconds = (value: number) => `${value} seconds`;

/** A started sign-in: the attempt, its browser-binding secret and where to send the browser. */
export interface LoginStart {
  readonly attemptId: string;
  /** Goes only into the HttpOnly browser cookie; the database keeps its hash. */
  readonly browserSecret: string;
  readonly authorizationUrl: string;
}

/** What the OAuth callback does next. */
export type LoginCompletion =
  /** Redirect the browser to the desktop loopback with a one-time code. */
  | { readonly kind: 'redirect'; readonly location: string }
  /** No valid attempt for this browser; show a page, nowhere safe to redirect. */
  | { readonly kind: 'expired' };

/** A refresh either rotates to a new token pair or is rejected (expired, revoked or replayed). */
export type RefreshOutcome =
  | { readonly kind: 'rotated'; readonly tokens: TokenResponseDto }
  | { readonly kind: 'rejected' };

/** Returned by auth.exchange_code / auth.refresh_session, profile included (one transaction). */
interface TokenRow {
  session_id: string;
  user_id: string;
  access_expires_at: Date;
  refresh_expires_at: Date;
  email: string;
  display_name: string | null;
}

/**
 * Browser sign-in, code exchange, session rotation and logout.
 *
 * All session state lives in `auth.*` tables reachable only through SECURITY DEFINER
 * functions; this service never sees a stored token, only hashes it computes.
 */
export class AuthService {
  constructor(
    private readonly database: Database,
    private readonly provider: IdentityProvider,
    private readonly policy: SessionPolicy,
    private readonly callbackUrl: string,
  ) {}

  async startLogin(input: {
    redirectUri: string;
    desktopState: string;
    codeChallenge: string;
  }): Promise<LoginStart> {
    const { authorizationUrl, providerSessionId } = await this.provider.begin(
      this.callbackUrl,
    );
    const browserSecret = generateSecret('swb');
    const attemptId = await this.database.withoutUser(async (sql) => {
      const rows = await sql.query<{ id: string }>(
        'SELECT auth.begin_login($1, $2, $3, $4, $5, $6::interval) AS id',
        [
          hashSecret(browserSecret),
          providerSessionId,
          input.redirectUri,
          input.desktopState,
          input.codeChallenge,
          seconds(this.policy.loginAttemptTtlSeconds),
        ],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error('Login attempt was not created');
      return id;
    });
    return { attemptId, browserSecret, authorizationUrl };
  }

  /**
   * Completes a browser sign-in. On provider refusal the desktop is still told (with
   * `error=access_denied`) so it stops waiting; the reason is never forwarded.
   */
  async completeLogin(input: {
    attemptId: string;
    browserSecret: string;
    callbackUrl: string;
  }): Promise<LoginCompletion> {
    const secretHash = hashSecret(input.browserSecret);
    const pending = await this.database.withoutUser((sql) =>
      sql.query<{
        provider_session_id: string;
        redirect_uri: string;
        desktop_state: string;
      }>('SELECT * FROM auth.pending_login($1, $2)', [
        input.attemptId,
        secretHash,
      ]),
    );
    const attempt = pending[0];
    if (!attempt) return { kind: 'expired' };

    const deny = (): LoginCompletion => {
      const location = new URL(attempt.redirect_uri);
      location.searchParams.set('error', 'access_denied');
      location.searchParams.set('state', attempt.desktop_state);
      return { kind: 'redirect', location: location.href };
    };

    let identity;
    try {
      identity = await this.provider.complete(
        input.callbackUrl,
        attempt.provider_session_id,
      );
    } catch (error) {
      if (error instanceof IdentityVerificationError) return deny();
      throw error;
    }

    const code = generateSecret('swc');
    const completed = await this.database.withoutUser((sql) =>
      sql.query<{ redirect_uri: string; desktop_state: string }>(
        'SELECT * FROM auth.complete_login($1, $2, $3, $4, $5, $6, $7, $8, $9::interval)',
        [
          input.attemptId,
          secretHash,
          identity.provider,
          identity.subject,
          identity.email,
          identity.emailVerified,
          identity.displayName,
          hashSecret(code),
          seconds(this.policy.authorizationCodeTtlSeconds),
        ],
      ),
    );
    const done = completed[0];
    if (!done) return deny();
    const location = new URL(done.redirect_uri);
    location.searchParams.set('code', code);
    location.searchParams.set('state', done.desktop_state);
    return { kind: 'redirect', location: location.href };
  }

  /** Exchanges a one-time code plus PKCE verifier for a new session. Null when rejected. */
  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<TokenResponseDto | null> {
    const accessToken = generateSecret('swa');
    const refreshToken = generateSecret('swr');
    const rows = await this.database.withoutUser((sql) =>
      sql.query<TokenRow>(
        `SELECT * FROM auth.exchange_code($1, $2, $3, $4, $5::interval, $6, $7::interval, $8::interval)`,
        [
          hashSecret(input.code),
          pkceChallenge(input.codeVerifier),
          input.redirectUri,
          hashSecret(accessToken),
          seconds(this.policy.accessTtlSeconds),
          hashSecret(refreshToken),
          seconds(this.policy.refreshIdleTtlSeconds),
          seconds(this.policy.refreshAbsoluteTtlSeconds),
        ],
      ),
    );
    const row = rows[0];
    return row ? tokenResponse(row, accessToken, refreshToken) : null;
  }

  async refresh(refreshTokenValue: string): Promise<RefreshOutcome> {
    const accessToken = generateSecret('swa');
    const refreshToken = generateSecret('swr');
    const rows = await this.database.withoutUser((sql) =>
      sql.query<{ outcome: string } & TokenRow>(
        `SELECT * FROM auth.refresh_session($1, $2, $3::interval, $4, $5::interval, $6::interval)`,
        [
          hashSecret(refreshTokenValue),
          hashSecret(accessToken),
          seconds(this.policy.accessTtlSeconds),
          hashSecret(refreshToken),
          seconds(this.policy.refreshIdleTtlSeconds),
          seconds(this.policy.refreshReuseGraceSeconds),
        ],
      ),
    );
    const row = rows[0];
    if (row?.outcome !== 'rotated') return { kind: 'rejected' };
    return {
      kind: 'rotated',
      tokens: tokenResponse(row, accessToken, refreshToken),
    };
  }

  /** Revokes the session owning this refresh token. Idempotent. */
  async logout(refreshToken: string): Promise<void> {
    await this.database.withoutUser((sql) =>
      sql.query('SELECT auth.revoke_session($1) AS revoked', [
        hashSecret(refreshToken),
      ]),
    );
  }

  /** Resolves a bearer token to a live session, or null. */
  async authenticate(accessToken: string): Promise<Principal | null> {
    const accessTokenHash = hashSecret(accessToken);
    const rows = await this.database.withoutUser((sql) =>
      sql.query<{ user_id: string; session_id: string }>(
        'SELECT * FROM auth.resolve_access_token($1)',
        [accessTokenHash],
      ),
    );
    const row = rows[0];
    return row
      ? { userId: row.user_id, sessionId: row.session_id, accessTokenHash }
      : null;
  }

  async currentUser(principal: Principal): Promise<UserDto> {
    const rows = await this.database.withUser(principal, (sql) =>
      sql.query<{ id: string; email: string; display_name: string | null }>(
        'SELECT id, email, display_name FROM app.users WHERE id = $1',
        [principal.userId],
      ),
    );
    const user = rows[0];
    if (!user) throw new Error('Authenticated user row is not visible');
    return { id: user.id, email: user.email, displayName: user.display_name };
  }
}

function tokenResponse(
  row: TokenRow,
  accessToken: string,
  refreshToken: string,
): TokenResponseDto {
  return {
    accessToken,
    accessTokenExpiresAt: row.access_expires_at.toISOString(),
    refreshToken,
    refreshTokenExpiresAt: row.refresh_expires_at.toISOString(),
    user: { id: row.user_id, email: row.email, displayName: row.display_name },
  };
}
