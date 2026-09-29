import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

/** The subset of Electron's `safeStorage` used here; injected so it can be tested. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface StoredSession {
  readonly version: 1;
  readonly apiBaseUrl: string;
  readonly refreshToken: string;
  readonly savedAt: string;
}

/**
 * Persists the one long-lived credential (the rotating refresh token) encrypted with
 * the OS store (Windows: DPAPI via `safeStorage`). The access token is never written.
 * Anything unreadable, undecryptable or bound to another backend is deleted.
 */
export class SecureSessionStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
  ) {}

  /** False when the OS offers no encryption; the session then lives in memory only. */
  get canPersist(): boolean {
    return this.cipher.isEncryptionAvailable();
  }

  async load(apiBaseUrl: string): Promise<string | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.filePath);
    } catch {
      return null;
    }
    try {
      if (!this.canPersist) throw new Error('Encryption unavailable');
      const parsed: unknown = JSON.parse(this.cipher.decryptString(encrypted));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'version' in parsed &&
        parsed.version === 1 &&
        'apiBaseUrl' in parsed &&
        parsed.apiBaseUrl === apiBaseUrl &&
        'refreshToken' in parsed &&
        typeof parsed.refreshToken === 'string' &&
        /^swr_[A-Za-z0-9_-]{20,128}$/.test(parsed.refreshToken)
      )
        return parsed.refreshToken;
    } catch {
      // Corrupted, tampered or from another OS account: treat as signed out.
    }
    await this.clear();
    return null;
  }

  async save(apiBaseUrl: string, refreshToken: string): Promise<void> {
    if (!this.canPersist) return;
    const session: StoredSession = {
      version: 1,
      apiBaseUrl,
      refreshToken,
      savedAt: new Date().toISOString(),
    };
    // Write-then-rename so a crash never leaves a half-written credential file.
    const temporary = `${this.filePath}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(
      temporary,
      this.cipher.encryptString(JSON.stringify(session)),
      { mode: 0o600 },
    );
    await rename(temporary, this.filePath);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
