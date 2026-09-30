import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '@swyft/contracts';
import { UpdateService, updateCheckInterval, type Updater } from './updates';

class FakeUpdater extends EventEmitter implements Updater {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checkForUpdates = vi.fn(async (): Promise<unknown> => undefined);
  quitAndInstall = vi.fn();
}

describe('UpdateService', () => {
  let updater: FakeUpdater;
  let published: UpdateStatus[];
  let service: UpdateService;

  beforeEach(() => {
    vi.useFakeTimers();
    updater = new FakeUpdater();
    published = [];
    service = new UpdateService(updater, (status) => published.push(status));
  });
  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  it('downloads in the background and installs on quit', () => {
    service.start();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it('checks at start-up and then every six hours', async () => {
    service.start();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(updateCheckInterval - 1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('reports a downloaded version once, and stops checking', async () => {
    service.start();
    expect(service.status()).toEqual({ state: 'none' });
    updater.emit('update-downloaded', { version: '1.1.1' });
    expect(published).toEqual([{ state: 'ready', version: '1.1.1' }]);
    expect(service.status()).toEqual({ state: 'ready', version: '1.1.1' });
    await vi.advanceTimersByTimeAsync(updateCheckInterval * 2);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('stays silent when offline or the feed fails', async () => {
    updater.checkForUpdates.mockRejectedValue(new Error('net::ERR_INTERNET'));
    service.start();
    updater.emit('error', new Error('net::ERR_INTERNET'));
    await vi.advanceTimersByTimeAsync(updateCheckInterval);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(published).toEqual([]);
    expect(service.status()).toEqual({ state: 'none' });
  });

  it('installs only when an update is ready, silently, then reopens the app', () => {
    service.start();
    expect(service.install()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    updater.emit('update-downloaded', { version: '1.1.1' });
    expect(service.install()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});
