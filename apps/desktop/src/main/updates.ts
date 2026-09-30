import type { UpdateStatus } from '@swyft/contracts';

/** IPC channels for updates; `status` is Main → Renderer only. */
export const updateChannels = {
  getStatus: 'updates:get-status:v1',
  install: 'updates:install:v1',
  status: 'updates:status:v1',
} as const;

/** How often the installed app looks for a new version while it stays open. */
export const updateCheckInterval = 6 * 60 * 60 * 1000;

/**
 * The part of electron-updater's `autoUpdater` this module uses, so tests can pass a fake.
 * electron-updater downloads the installer named in the feed's `latest.yml` and checks its
 * SHA-512 before reporting `update-downloaded`.
 */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(
    event: 'update-downloaded',
    listener: (info: { readonly version: string }) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/**
 * Automatic updates for the installed Windows app.
 *
 * - Checks once at start-up and then every {@link updateCheckInterval}; a new version
 *   downloads in the background.
 * - Nothing interrupts the broker: when the download is ready the UI shows a notice, and
 *   the update installs when they choose "Restart" or next quit the app.
 * - Being offline or an unreachable feed is silent; the next check simply tries again.
 */
export class UpdateService {
  private readyVersion: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly updater: Updater,
    private readonly publish: (status: UpdateStatus) => void,
    private readonly interval = updateCheckInterval,
  ) {}

  /** Starts checking. Call once, after the window exists. */
  start(): void {
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.on('update-downloaded', (info) => {
      this.readyVersion = info.version;
      this.publish(this.status());
    });
    // Errors (offline, feed unavailable, checksum mismatch) are deliberately silent.
    this.updater.on('error', () => undefined);
    void this.check();
    this.timer = setInterval(() => void this.check(), this.interval);
    this.timer.unref?.();
  }

  /** Stops the periodic check (the app is quitting). */
  stop(): void {
    clearInterval(this.timer);
  }

  status(): UpdateStatus {
    return this.readyVersion === undefined
      ? { state: 'none' }
      : { state: 'ready', version: this.readyVersion };
  }

  /**
   * Quits, installs the downloaded update without the installer's pages, and reopens the
   * app. Returns false (and does nothing) if no update is ready.
   */
  install(): boolean {
    if (this.readyVersion === undefined) return false;
    this.stop();
    this.updater.quitAndInstall(true, true);
    return true;
  }

  private async check(): Promise<void> {
    if (this.readyVersion !== undefined) return;
    try {
      await this.updater.checkForUpdates();
    } catch {
      // Same as the 'error' event: try again at the next check.
    }
  }
}
