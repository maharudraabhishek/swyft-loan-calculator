import type { MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '@swyft/contracts';

/** What the menu can do: notify the UI, or show one of Main's dialogs. */
export interface MenuActions {
  /** Forwards an app command to the UI (Main → Renderer, one way). */
  readonly send: (command: MenuCommand) => void;
  readonly showAbout: () => void;
  readonly showShortcuts: () => void;
}

/** Build facts that change the menu. */
export interface MenuOptions {
  /** Installed builds get no reload or developer tools. */
  readonly packaged: boolean;
  /** macOS puts the application name menu first and uses Cmd shortcuts. */
  readonly mac: boolean;
  readonly appName: string;
}

/** Shortcuts listed in Help → Keyboard shortcuts; kept next to the menu that defines them. */
export const shortcutSummary: ReadonlyArray<readonly [string, string]> = [
  ['Ctrl+N', 'New deal'],
  ['Ctrl+1', 'Calculator'],
  ['Ctrl+2', 'Lenders'],
  ['Ctrl+B', 'Show or hide the deal list'],
  ['Ctrl+C / Ctrl+V', 'Copy / paste'],
  ['Ctrl+Plus / Ctrl+Minus / Ctrl+0', 'Zoom in / out / reset'],
  ['F11', 'Full screen'],
  ['Ctrl+W', 'Close the window'],
];

/**
 * The native application menu. Standard editing, zoom and window items use Electron
 * roles, so they behave like any other desktop app. App commands only notify the UI.
 * Reload and developer tools exist in development builds only: without a custom menu,
 * Electron's default menu would expose both in the installed app.
 */
export function buildMenuTemplate(
  options: MenuOptions,
  actions: MenuActions,
): MenuItemConstructorOptions[] {
  const command = (name: MenuCommand) => () => actions.send(name);

  const template: MenuItemConstructorOptions[] = [];
  if (options.mac) template.push({ role: 'appMenu' });

  template.push(
    {
      label: '&File',
      submenu: [
        {
          label: 'New Deal',
          accelerator: 'CmdOrCtrl+N',
          click: command('new-deal'),
        },
        { type: 'separator' },
        { role: 'close' },
        ...(options.mac ? [] : [{ role: 'quit' } as const]),
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        {
          label: 'Calculator',
          accelerator: 'CmdOrCtrl+1',
          click: command('show-calculator'),
        },
        {
          label: 'Lenders',
          accelerator: 'CmdOrCtrl+2',
          click: command('show-lenders'),
        },
        {
          label: 'Show or Hide Deal List',
          accelerator: 'CmdOrCtrl+B',
          click: command('toggle-deal-list'),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(options.packaged
          ? []
          : ([
              { type: 'separator' },
              { role: 'reload' },
              { role: 'toggleDevTools' },
            ] as const)),
      ],
    },
    {
      label: '&Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: () => actions.showShortcuts() },
        { type: 'separator' },
        {
          label: `About ${options.appName}`,
          click: () => actions.showAbout(),
        },
      ],
    },
  );
  return template;
}
