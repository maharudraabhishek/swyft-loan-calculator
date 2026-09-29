import type { DesktopBridge } from '@swyft/contracts';

declare global {
  interface Window {
    readonly swyft?: DesktopBridge;
  }
}

export {};
