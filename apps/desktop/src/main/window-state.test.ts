import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultWindowSize,
  minimumWindowSize,
  pixelGridStep,
  placeWindow,
  snapToPixelGrid,
  WindowStateFile,
} from './window-state';

const laptop = { x: 0, y: 0, width: 1920, height: 1040 };
const rightMonitor = { x: 1920, y: 0, width: 2560, height: 1400 };

const saved = (
  bounds: { x: number; y: number; width: number; height: number },
  mode: { maximized?: boolean; fullScreen?: boolean } = {},
) => ({
  version: 1,
  bounds,
  maximized: mode.maximized ?? false,
  fullScreen: mode.fullScreen ?? false,
});

describe('placeWindow', () => {
  it('opens at the default size, centred, when nothing was saved', () => {
    expect(placeWindow(undefined, [laptop])).toEqual({
      ...defaultWindowSize,
      maximized: false,
      fullScreen: false,
    });
  });

  it('ignores unreadable or out-of-range files', () => {
    for (const bad of [
      'not json',
      { version: 2, bounds: { x: 0, y: 0, width: 900, height: 700 } },
      saved({ x: 0, y: 0, width: -5, height: 700 }),
      { ...saved({ x: 0, y: 0, width: 900, height: 700 }), extra: true },
    ])
      expect(placeWindow(bad, [laptop])).toEqual({
        ...defaultWindowSize,
        maximized: false,
        fullScreen: false,
      });
  });

  it('restores the saved position and size on a connected screen', () => {
    expect(
      placeWindow(saved({ x: 2100, y: 80, width: 1400, height: 900 }), [
        laptop,
        rightMonitor,
      ]),
    ).toEqual({
      x: 2100,
      y: 80,
      width: 1400,
      height: 900,
      maximized: false,
      fullScreen: false,
    });
  });

  it('centres the window on the main screen when its monitor was unplugged', () => {
    expect(
      placeWindow(saved({ x: 2100, y: 80, width: 1400, height: 900 }), [
        laptop,
      ]),
    ).toEqual({
      width: 1400,
      height: 900,
      maximized: false,
      fullScreen: false,
    });
  });

  it('pulls a partly off-screen window fully back onto its screen', () => {
    expect(
      placeWindow(saved({ x: 1500, y: 700, width: 1000, height: 700 }), [
        laptop,
      ]),
    ).toMatchObject({ x: 920, y: 340, width: 1000, height: 700 });
  });

  it('keeps the size between the app minimum and the screen', () => {
    expect(
      placeWindow(saved({ x: 10, y: 10, width: 300, height: 200 }), [laptop]),
    ).toMatchObject(minimumWindowSize);
    expect(
      placeWindow(saved({ x: 0, y: 0, width: 5000, height: 3000 }), [laptop]),
    ).toMatchObject({ x: 0, y: 0, width: 1920, height: 1040 });
  });

  it('remembers maximized and full-screen modes', () => {
    expect(
      placeWindow(
        saved(
          { x: 100, y: 100, width: 1000, height: 700 },
          { maximized: true },
        ),
        [laptop],
      ),
    ).toMatchObject({ maximized: true, fullScreen: false });
  });
});

describe('snapToPixelGrid', () => {
  const placement = {
    x: 137,
    y: 91,
    width: 1012,
    height: 691,
    maximized: false,
    fullScreen: false,
  };

  it('knows the pixel grid of common display scales', () => {
    expect(
      [1, 1.25, 1.5, 1.75, 2, 2.5].map((scale) => pixelGridStep(scale)),
    ).toEqual([1, 4, 2, 4, 1, 2]);
    // Electron reports scales as 32-bit floats: 1.1 arrives as 1.100000023841858.
    expect(pixelGridStep(1.100000023841858)).toBe(10);
  });

  it('leaves placements alone where every value is already a whole pixel', () => {
    expect(snapToPixelGrid(placement, 1)).toEqual(placement);
    expect(snapToPixelGrid(placement, 2)).toEqual(placement);
  });

  it('moves position and size onto whole pixels at 125% (the window grew on every launch)', () => {
    const snapped = snapToPixelGrid(placement, 1.25);
    expect(snapped).toEqual({ ...placement, x: 136, y: 92, height: 692 });
    for (const value of [snapped.x, snapped.y, snapped.width, snapped.height])
      expect(Number.isInteger((value ?? 0) * 1.25)).toBe(true);
    // Idempotent: a snapped placement saved and reopened stays where it is.
    expect(snapToPixelGrid(snapped, 1.25)).toEqual(snapped);
  });

  it('keeps a centred placement centred and never goes below the minimum size', () => {
    const snapped = snapToPixelGrid(
      {
        width: minimumWindowSize.width + 1,
        height: minimumWindowSize.height + 1,
        maximized: true,
        fullScreen: false,
      },
      1.25,
    );
    expect(snapped).toEqual({
      width: minimumWindowSize.width,
      height: minimumWindowSize.height,
      maximized: true,
      fullScreen: false,
    });
    expect(
      snapToPixelGrid(
        { width: 781, height: 561, maximized: false, fullScreen: false },
        1.100000023841858,
      ),
    ).toEqual({ width: 780, height: 560, maximized: false, fullScreen: false });
  });
});

describe('WindowStateFile', () => {
  let directory = '';
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('saves and loads the state, leaving no temporary files', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'swyft-window-'));
    const file = new WindowStateFile(path.join(directory, 'window-state.json'));
    expect(file.load()).toBeUndefined();
    const state = {
      bounds: { x: 12, y: 34, width: 1100, height: 760 },
      maximized: true,
      fullScreen: false,
    };
    file.save(state);
    expect(file.load()).toEqual({ version: 1, ...state });
    expect(placeWindow(file.load(), [laptop])).toMatchObject({
      x: 12,
      y: 34,
      maximized: true,
    });
    expect(readdirSync(directory)).toEqual(['window-state.json']);
  });

  it('treats a corrupt file as "nothing saved"', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'swyft-window-'));
    const filePath = path.join(directory, 'window-state.json');
    writeFileSync(filePath, '{ half written', 'utf8');
    expect(new WindowStateFile(filePath).load()).toBeUndefined();
  });
});
