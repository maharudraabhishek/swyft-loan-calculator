import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { buildMenuTemplate, shortcutSummary } from './app-menu';

function flatten(
  items: readonly MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ]);
}

function setup(options: { packaged: boolean; mac?: boolean }) {
  const actions = {
    send: vi.fn(),
    showAbout: vi.fn(),
    showShortcuts: vi.fn(),
  };
  const template = buildMenuTemplate(
    {
      packaged: options.packaged,
      mac: options.mac ?? false,
      appName: 'Swyft Finance',
    },
    actions,
  );
  const items = flatten(template);
  const click = (label: string) => {
    const item = items.find((entry) => entry.label === label);
    if (!item?.click) throw new Error(`No clickable item ${label}`);
    // Electron passes (menuItem, window, event); the handlers ignore them.
    (item.click as () => void)();
  };
  return { template, items, actions, click };
}

describe('application menu', () => {
  it('has the standard desktop menus', () => {
    const { template } = setup({ packaged: true });
    expect(template.map((menu) => menu.label)).toEqual([
      '&File',
      '&Edit',
      '&View',
      '&Window',
      '&Help',
    ]);
  });

  it('gives the installed app no reload or developer tools', () => {
    const roles = setup({ packaged: true }).items.map((item) => item.role);
    expect(roles).not.toContain('reload');
    expect(roles).not.toContain('forceReload');
    expect(roles).not.toContain('toggleDevTools');
    expect(roles).toEqual(
      expect.arrayContaining([
        'undo',
        'redo',
        'cut',
        'copy',
        'paste',
        'selectAll',
      ]),
    );
  });

  it('keeps reload and developer tools in development builds', () => {
    const roles = setup({ packaged: false }).items.map((item) => item.role);
    expect(roles).toEqual(expect.arrayContaining(['reload', 'toggleDevTools']));
  });

  it('sends each app command to the UI from its menu item', () => {
    const { click, actions, items } = setup({ packaged: true });
    click('New Deal');
    click('Calculator');
    click('Lenders');
    click('Show or Hide Deal List');
    expect(actions.send.mock.calls.map(([command]) => command)).toEqual([
      'new-deal',
      'show-calculator',
      'show-lenders',
      'toggle-deal-list',
    ]);
    const accelerators = Object.fromEntries(
      items
        .filter((item) => item.accelerator)
        .map((item) => [item.label, item.accelerator]),
    );
    expect(accelerators).toEqual({
      'New Deal': 'CmdOrCtrl+N',
      Calculator: 'CmdOrCtrl+1',
      Lenders: 'CmdOrCtrl+2',
      'Show or Hide Deal List': 'CmdOrCtrl+B',
    });
  });

  it('opens About and the shortcut list from Help', () => {
    const { click, actions } = setup({ packaged: true });
    click('Keyboard Shortcuts');
    click('About Swyft Finance');
    expect(actions.showShortcuts).toHaveBeenCalledOnce();
    expect(actions.showAbout).toHaveBeenCalledOnce();
    expect(actions.send).not.toHaveBeenCalled();
  });

  it('follows macOS conventions on a Mac build', () => {
    const { template } = setup({ packaged: true, mac: true });
    expect(template[0]).toEqual({ role: 'appMenu' });
    const file = template.find((menu) => menu.label === '&File');
    const fileRoles = (file?.submenu as MenuItemConstructorOptions[]).map(
      (item) => item.role,
    );
    expect(fileRoles).not.toContain('quit');
  });

  it('lists every app shortcut in the Help summary', () => {
    const keys = shortcutSummary.map(([shortcut]) => shortcut);
    expect(keys).toEqual(
      expect.arrayContaining(['Ctrl+N', 'Ctrl+1', 'Ctrl+2', 'Ctrl+B']),
    );
  });
});
