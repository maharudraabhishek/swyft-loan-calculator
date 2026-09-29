import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AuthStateDto } from '@swyft/contracts';
import { AuthApiClient } from './auth/api-client';
import { startLoopbackReceiver } from './auth/loopback';
import { AuthSessionManager } from './auth/session-manager';
import { SecureSessionStore } from './auth/session-store';
import { resolveApiBaseUrl } from './api-base-url';
import { BusinessApiClient } from './api/business-api';
import { createBusinessHandlers } from './ipc/business-handlers';
import { pickLogoFile } from './logo-file';

const appHost = 'swyft';
const appOrigin = `app://${appHost}`;
const authChannels = {
  getState: 'auth:get-state:v1',
  signIn: 'auth:sign-in:v1',
  signOut: 'auth:sign-out:v1',
  retry: 'auth:retry:v1',
  stateChanged: 'auth:state-changed:v1',
} as const;
const rendererDirectory = path.join(__dirname, '../renderer');

// Development runs keep their own profile, so a dev session (local API) can never
// overwrite the installed app's remembered session. Must run before `ready`.
if (!app.isPackaged)
  app.setPath(
    'userData',
    path.join(app.getPath('appData'), 'Swyft Finance (development)'),
  );

// A privileged local scheme avoids exposing the renderer through file:// URL privileges.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let mainWindow: BrowserWindow | undefined;
let authManager: AuthSessionManager | undefined;

function publishAuthState(state: AuthStateDto): void {
  mainWindow?.webContents.send(authChannels.stateChanged, state);
  if (state.status === 'signed-in' && mainWindow) {
    // Bring the app forward after the browser hand-off completes.
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

function createAuthManager(apiBaseUrl: string): AuthSessionManager {
  const api = new AuthApiClient(apiBaseUrl, (input, init) =>
    net.fetch(input, init),
  );
  return new AuthSessionManager({
    api,
    store: new SecureSessionStore(
      path.join(app.getPath('userData'), 'session.bin'),
      safeStorage,
    ),
    // Only the configured API origin is ever opened, and only in the system browser.
    openBrowser: async (url) => {
      if (new URL(url).origin !== new URL(apiBaseUrl).origin)
        throw new Error('Refusing to open an unexpected sign-in origin');
      await shell.openExternal(url);
    },
    startLoopback: startLoopbackReceiver,
    onStateChanged: publishAuthState,
  });
}

function isTrustedRenderer(
  sender: Electron.WebContents,
  frame: Electron.WebFrameMain | null,
): boolean {
  if (
    !mainWindow ||
    sender !== mainWindow.webContents ||
    !frame ||
    frame !== sender.mainFrame
  )
    return false;
  try {
    const frameUrl = new URL(frame.url);
    if (frameUrl.href === `${appOrigin}/index.html`) return true;
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (app.isPackaged || devUrl === undefined) return false;
    const configuredUrl = new URL(devUrl);
    return (
      configuredUrl.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(configuredUrl.hostname) &&
      frameUrl.origin === configuredUrl.origin
    );
  } catch {
    return false;
  }
}

function registerLocalProtocol(): void {
  protocol.handle('app', (request) => {
    let localPath: string;
    try {
      const requestedUrl = new URL(request.url);
      if (requestedUrl.hostname !== appHost)
        return new Response('Not found', { status: 404 });
      localPath = path.resolve(
        rendererDirectory,
        `.${decodeURIComponent(requestedUrl.pathname)}`,
      );
    } catch {
      return new Response('Not found', { status: 404 });
    }
    if (
      !localPath.startsWith(`${rendererDirectory}${path.sep}`) ||
      !existsSync(localPath) ||
      !statSync(localPath).isFile()
    ) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(localPath).toString());
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 780,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f4f7fb',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  // The Renderer can never navigate, open windows, attach webviews or gain browser permissions.
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) =>
    event.preventDefault(),
  );
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
  if (devUrl !== undefined) {
    const parsed = new URL(devUrl);
    if (
      parsed.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    ) {
      throw new Error('The development renderer must use loopback HTTP.');
    }
  }
  const load = devUrl
    ? window.loadURL(devUrl)
    : window.loadURL(`${appOrigin}/index.html`);
  void load.catch(() => {
    dialog.showErrorBox(
      'Swyft Finance',
      'The desktop interface could not load. Restart the application.',
    );
    window.show();
  });
}

app.whenReady().then(() => {
  registerLocalProtocol();
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (!process.env.ELECTRON_RENDERER_URL) {
    session.defaultSession.webRequest.onHeadersReceived(
      { urls: [`${appOrigin}/*`] },
      (details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [
              "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
            ],
          },
        });
      },
    );
  }
  const apiBaseUrl = resolveApiBaseUrl(
    import.meta.env.MAIN_VITE_API_BASE_URL,
    app.isPackaged,
  );
  authManager = createAuthManager(apiBaseUrl);
  const manager = authManager;
  // Auth channels take no arguments: the Renderer can ask, never steer or read tokens.
  const handleAuth = (channel: string, action: () => unknown) =>
    ipcMain.handle(channel, (event) => {
      if (!isTrustedRenderer(event.sender, event.senderFrame))
        throw new Error('Untrusted request');
      return action();
    });
  handleAuth(authChannels.getState, () => manager.getState());
  handleAuth(authChannels.signIn, () => {
    void manager.signIn();
  });
  handleAuth(authChannels.signOut, () => manager.signOut());
  handleAuth(authChannels.retry, () => manager.restore());
  const businessApi = new BusinessApiClient(
    apiBaseUrl,
    (call) => manager.withAccessToken(call),
    (input, init) => net.fetch(input, init),
  );
  // Business channels: trusted sender only, then per-channel zod argument validation.
  // One atomic write carrying both formats, so email clients paste the tables and
  // plain-text editors get readable text.
  const handlers = createBusinessHandlers(
    businessApi,
    (content) =>
      clipboard.write([
        new ClipboardItem({
          'text/html': content.html,
          'text/plain': content.text,
        }),
      ]),
    () => pickLogoFile(dialog, mainWindow),
  );
  for (const [channel, handler] of Object.entries(handlers))
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!isTrustedRenderer(event.sender, event.senderFrame))
        throw new Error('Untrusted request');
      return handler(args);
    });
  createWindow();
  void manager.restore();
});

app.on('window-all-closed', () => app.quit());
