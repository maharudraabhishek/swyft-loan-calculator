import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AuthStateDto, MenuCommand, UpdateStatus } from '@swyft/contracts';
import { autoUpdater } from 'electron-updater';
import { buildMenuTemplate, shortcutSummary } from './app-menu';
import { AuthApiClient } from './auth/api-client';
import { startLoopbackReceiver } from './auth/loopback';
import { AuthSessionManager } from './auth/session-manager';
import { SecureSessionStore } from './auth/session-store';
import { resolveApiBaseUrl } from './api-base-url';
import { BusinessApiClient } from './api/business-api';
import { createBusinessHandlers } from './ipc/business-handlers';
import { pickLogoFile } from './logo-file';
import { UpdateService, updateChannels } from './updates';
import {
  minimumWindowSize,
  placeWindow,
  snapToPixelGrid,
  WindowStateFile,
} from './window-state';

const appHost = 'swyft';
const appOrigin = `app://${appHost}`;
const appName = 'Swyft Finance';
const authChannels = {
  getState: 'auth:get-state:v1',
  signIn: 'auth:sign-in:v1',
  signOut: 'auth:sign-out:v1',
  retry: 'auth:retry:v1',
  stateChanged: 'auth:state-changed:v1',
} as const;
/** Main → Renderer only; the Renderer can listen but never send on it. */
const menuCommandChannel = 'menu:command:v1';
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
let updateService: UpdateService | undefined;

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

/**
 * Automatic updates run only in the installed Windows app: electron-builder writes the
 * feed address to `resources/app-update.yml` (see `win.publish` in electron-builder.yml).
 * Development runs and macOS builds (which need an Apple signature to update) never check.
 */
function createUpdateService(): UpdateService | undefined {
  if (
    !app.isPackaged ||
    process.platform !== 'win32' ||
    !existsSync(path.join(process.resourcesPath, 'app-update.yml'))
  )
    return undefined;
  return new UpdateService(autoUpdater, (status: UpdateStatus) =>
    mainWindow?.webContents.send(updateChannels.status, status),
  );
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

/** Sends a menu command to the app window's UI, if it is open. */
function sendMenuCommand(command: MenuCommand): void {
  mainWindow?.webContents.send(menuCommandChannel, command);
}

function showAbout(): void {
  void dialog.showMessageBox({
    type: 'info',
    title: `About ${appName}`,
    message: appName,
    detail: `Version ${app.getVersion()}\nMulti-lender quoting calculator for finance brokers.`,
    buttons: ['OK'],
  });
}

function showShortcuts(): void {
  const lines = shortcutSummary.map(([keys, action]) => `${keys}\t${action}`);
  void dialog.showMessageBox({
    type: 'info',
    title: 'Keyboard shortcuts',
    message: 'Keyboard shortcuts',
    detail: lines.join('\n'),
    buttons: ['OK'],
  });
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate(
        {
          packaged: app.isPackaged,
          mac: process.platform === 'darwin',
          appName,
        },
        { send: sendMenuCommand, showAbout, showShortcuts },
      ),
    ),
  );
}

function createWindow(): void {
  // Reopen where the user left the window, if that spot is still on a connected screen.
  const stateFile = new WindowStateFile(
    path.join(app.getPath('userData'), 'window-state.json'),
  );
  const placed = placeWindow(
    stateFile.load(),
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const target =
    placed.x !== undefined && placed.y !== undefined
      ? screen.getDisplayMatching({
          x: placed.x,
          y: placed.y,
          width: placed.width,
          height: placed.height,
        })
      : screen.getPrimaryDisplay();
  const placement = snapToPixelGrid(placed, target.scaleFactor);
  const window = new BrowserWindow({
    width: placement.width,
    height: placement.height,
    minWidth: minimumWindowSize.width,
    minHeight: minimumWindowSize.height,
    show: false,
    backgroundColor: '#f4f7fb',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  // Positioned with setBounds rather than the constructor: at fractional display scales
  // the constructor's own rounding still adds a few pixels.
  if (placement.x !== undefined && placement.y !== undefined)
    window.setBounds({
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
    });
  if (placement.maximized) window.maximize();
  if (placement.fullScreen) window.setFullScreen(true);
  window.once('ready-to-show', () => window.show());

  // Save the normal (not maximized) bounds plus the mode, shortly after the user stops
  // moving or resizing, and once more when the window closes.
  const saveState = () =>
    stateFile.save({
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    });
  let saveTimer: NodeJS.Timeout | undefined;
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 500);
  };
  window.on('resize', saveSoon);
  window.on('move', saveSoon);
  window.on('maximize', saveSoon);
  window.on('unmaximize', saveSoon);
  window.on('enter-full-screen', saveSoon);
  window.on('leave-full-screen', saveSoon);
  window.on('close', () => {
    clearTimeout(saveTimer);
    saveState();
  });
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
  installApplicationMenu();
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
  // Auth and update channels take no arguments: the Renderer can ask, never steer or
  // read tokens.
  const handleNoArgs = (channel: string, action: () => unknown) =>
    ipcMain.handle(channel, (event) => {
      if (!isTrustedRenderer(event.sender, event.senderFrame))
        throw new Error('Untrusted request');
      return action();
    });
  handleNoArgs(authChannels.getState, () => manager.getState());
  handleNoArgs(authChannels.signIn, () => {
    void manager.signIn();
  });
  handleNoArgs(authChannels.signOut, () => manager.signOut());
  handleNoArgs(authChannels.retry, () => manager.restore());
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
  updateService = createUpdateService();
  handleNoArgs(
    updateChannels.getStatus,
    (): UpdateStatus => updateService?.status() ?? { state: 'none' },
  );
  handleNoArgs(updateChannels.install, () => {
    updateService?.install();
  });
  createWindow();
  void manager.restore();
  updateService?.start();
});

app.on('window-all-closed', () => app.quit());
