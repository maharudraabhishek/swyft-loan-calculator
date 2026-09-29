import { readFile, stat } from 'node:fs/promises';
import type { BrowserWindow, Dialog } from 'electron';
import { ApiRequestError, maxLogoBytes } from './api/business-api';

/**
 * Lets the broker pick a logo with the system dialog. The Renderer never supplies a path
 * or file bytes: Main chooses the file, refuses anything over the API's 512 KB limit
 * before reading it, and the API client verifies the image signature before upload.
 */
export async function pickLogoFile(
  dialog: Pick<Dialog, 'showOpenDialog'>,
  window: BrowserWindow | undefined,
): Promise<Uint8Array | null> {
  const options = {
    title: 'Choose a lender logo',
    properties: ['openFile' as const],
    filters: [
      {
        name: 'Images (PNG, JPEG, WebP)',
        extensions: ['png', 'jpg', 'jpeg', 'webp'],
      },
    ],
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  const path = result.filePaths[0];
  if (result.canceled || path === undefined) return null;
  if ((await stat(path)).size > maxLogoBytes)
    throw new ApiRequestError({
      kind: 'validation',
      message: 'The logo must be 512 KB or smaller.',
    });
  return new Uint8Array(await readFile(path));
}
