import { createHash, randomBytes } from 'node:crypto';
import type { AuthStateDto, TokenResponseDto, UserDto } from '@swyft/contracts';
import {
  OfflineError,
  UnauthorizedError,
  type AuthApiClient,
} from './api-client';
import type { LoopbackReceiver } from './loopback';
import type { SecureSessionStore } from './session-store';

export interface SessionManagerDependencies {
  readonly api: AuthApiClient;
  readonly store: SecureSessionStore;
  /** Opens the user's default browser (Electron `shell.openExternal`). */
  readonly openBrowser: (url: string) => Promise<void>;
  readonly startLoopback: (
    state: string,
    timeoutMs: number,
  ) => Promise<LoopbackReceiver>;
  readonly onStateChanged: (state: AuthStateDto) => void;
  readonly now?: () => number;
}

const signInTimeoutMs = 5 * 60_000;
/** Refresh slightly early so requests do not race expiry; the server remains the authority. */
const refreshMarginMs = 60_000;

interface LiveSession {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  user: UserDto;
}

/** Tokens arrived for a session that was signed out while the request was in flight. */
class StaleSessionError extends UnauthorizedError {}

const base64Url = (bytes: Buffer) => bytes.toString('base64url');

/**
 * Owns the desktop session in the Main process. Tokens stay here: the access token only
 * in memory, the refresh token also encrypted on disk. The Renderer only ever receives
 * `AuthStateDto`.
 *
 * `generation` increments on sign-out, so a refresh or code exchange that completes
 * afterwards is discarded (and revoked) instead of resurrecting the session.
 */
export class AuthSessionManager {
  private state: AuthStateDto;
  private session: LiveSession | undefined;
  private refreshing: Promise<LiveSession> | undefined;
  private signInAttempt: LoopbackReceiver | undefined;
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly dependencies: SessionManagerDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.state = {
      status: 'restoring',
      remembersSession: dependencies.store.canPersist,
    };
  }

  getState(): AuthStateDto {
    return this.state;
  }

  /**
   * Restores a remembered session at startup, or when the user retries from the offline
   * screen. Only a definite rejection (401) forgets the stored token; outages keep it.
   */
  async restore(): Promise<void> {
    const status = this.state.status;
    if (
      status !== 'restoring' &&
      status !== 'offline' &&
      status !== 'signed-out'
    )
      return;
    this.setState({ status: 'restoring' });
    const refreshToken = await this.dependencies.store.load(
      this.dependencies.api.baseUrl,
    );
    if (!refreshToken) return this.setState({ status: 'signed-out' });
    try {
      await this.refreshShared(refreshToken);
      void this.confirmProfile();
    } catch (error) {
      // refreshShared already signed out on UnauthorizedError.
      if (error instanceof UnauthorizedError) return;
      this.setState({
        status: 'offline',
        message:
          error instanceof OfflineError
            ? 'You appear to be offline. Your sign-in is kept; retry when connected.'
            : 'The Swyft service is unavailable right now. Your sign-in is kept; try again shortly.',
      });
    }
  }

  /** Runs the system-browser sign-in. A second call while one is running is ignored. */
  async signIn(): Promise<void> {
    if (this.state.status === 'signing-in' || this.state.status === 'signed-in')
      return;
    const generation = this.generation;
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash('sha256').update(verifier).digest());
    const attemptState = base64Url(randomBytes(24));
    this.setState({ status: 'signing-in' });
    let receiver: LoopbackReceiver | undefined;
    try {
      receiver = await this.dependencies.startLoopback(
        attemptState,
        signInTimeoutMs,
      );
      this.signInAttempt = receiver;
      await this.dependencies.openBrowser(
        this.dependencies.api.loginUrl({
          redirectUri: receiver.redirectUri,
          state: attemptState,
          codeChallenge: challenge,
        }),
      );
      const result = await receiver.result;
      if (generation !== this.generation) return;
      if (result.kind !== 'code')
        return this.setState({
          status: 'signed-out',
          message:
            result.kind === 'denied'
              ? 'Sign-in was cancelled or refused.'
              : 'Sign-in timed out. Try again.',
        });
      const tokens = await this.dependencies.api.exchangeCode({
        code: result.code,
        codeVerifier: verifier,
        redirectUri: receiver.redirectUri,
      });
      await this.accept(tokens, generation);
      void this.confirmProfile();
    } catch (error) {
      if (error instanceof StaleSessionError) return;
      this.setState({
        status: 'signed-out',
        message:
          error instanceof OfflineError
            ? 'You appear to be offline. Connect to the internet and try again.'
            : 'Sign-in could not be completed. Try again.',
      });
    } finally {
      receiver?.close();
      this.signInAttempt = undefined;
    }
  }

  /**
   * Clears local state first so sign-out always succeeds on this device, then asks the
   * API to revoke the session (best effort; the refresh token is gone locally either way).
   */
  async signOut(): Promise<void> {
    this.generation += 1;
    this.signInAttempt?.close();
    const refreshToken =
      this.session?.refreshToken ??
      (await this.dependencies.store.load(this.dependencies.api.baseUrl));
    await this.forget();
    this.setState({ status: 'signed-out' });
    if (refreshToken)
      await this.dependencies.api.logout(refreshToken).catch(() => undefined);
  }

  /**
   * Runs an authenticated API call with a fresh access token; on 401 it refreshes once and
   * retries. Refreshes are single-flight so concurrent calls cannot replay a refresh token.
   */
  async withAccessToken<T>(
    call: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const session = await this.currentSession();
    try {
      return await call(session.accessToken);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      // Another call may already have rotated the session.
      const latest =
        this.session && this.session.accessToken !== session.accessToken
          ? this.session
          : await this.refreshShared(session.refreshToken);
      return call(latest.accessToken);
    }
  }

  private async currentSession(): Promise<LiveSession> {
    const session = this.session;
    if (!session) throw new UnauthorizedError();
    if (session.accessExpiresAt - refreshMarginMs > this.now()) return session;
    return this.refreshShared(session.refreshToken);
  }

  /**
   * One authenticated request after sign-in or restore: proves the session works against
   * the API and keeps the displayed profile current. Failures are non-fatal; a 401 is
   * handled by `withAccessToken` (refresh once, then sign out).
   */
  private async confirmProfile(): Promise<void> {
    try {
      const user = await this.withAccessToken((token) =>
        this.dependencies.api.me(token),
      );
      if (this.state.status === 'signed-in')
        this.setState({
          status: 'signed-in',
          user: { email: user.email, displayName: user.displayName },
        });
    } catch {
      // Offline or signed out meanwhile: the current state already reflects it.
    }
  }

  private refreshShared(refreshToken: string): Promise<LiveSession> {
    const generation = this.generation;
    this.refreshing ??= this.dependencies.api
      .refresh(refreshToken)
      .then((tokens) => this.accept(tokens, generation))
      .catch(async (error: unknown) => {
        if (
          error instanceof UnauthorizedError &&
          !(error instanceof StaleSessionError)
        ) {
          await this.forget();
          this.setState({
            status: 'signed-out',
            message: 'Your session has ended. Sign in again.',
          });
        }
        throw error;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  private async accept(
    tokens: TokenResponseDto,
    generation: number,
  ): Promise<LiveSession> {
    if (generation !== this.generation) {
      // Signed out while this request was in flight: revoke what just arrived.
      await this.dependencies.api
        .logout(tokens.refreshToken)
        .catch(() => undefined);
      throw new StaleSessionError();
    }
    const session: LiveSession = {
      accessToken: tokens.accessToken,
      accessExpiresAt: Date.parse(tokens.accessTokenExpiresAt),
      refreshToken: tokens.refreshToken,
      user: tokens.user,
    };
    this.session = session;
    // Persist before announcing: a crash now must not lose the only valid refresh token.
    await this.dependencies.store.save(
      this.dependencies.api.baseUrl,
      tokens.refreshToken,
    );
    this.setState({
      status: 'signed-in',
      user: { email: tokens.user.email, displayName: tokens.user.displayName },
    });
    return session;
  }

  private async forget(): Promise<void> {
    this.session = undefined;
    await this.dependencies.store.clear();
  }

  private setState(next: Omit<AuthStateDto, 'remembersSession'>): void {
    this.state = {
      ...next,
      remembersSession: this.dependencies.store.canPersist,
    };
    this.dependencies.onStateChanged(this.state);
  }
}
