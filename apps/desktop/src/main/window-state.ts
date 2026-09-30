import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

/** Screen rectangle in device-independent pixels. */
export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What is remembered between launches: the normal (restored) bounds plus the mode. */
export interface WindowState {
  readonly bounds: Rectangle;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

/** Where to open the window. No `x`/`y` means "let Electron centre it". */
export interface WindowPlacement {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

/** First-launch window size. */
export const defaultWindowSize = { width: 1200, height: 800 } as const;
/** Smallest usable window (a small laptop screen); the layout is designed for it. */
export const minimumWindowSize = { width: 780, height: 560 } as const;

/** How much of the window must land on a screen to reuse the saved position. */
const minimumVisible = { width: 160, height: 60 } as const;

const pixels = z.number().int().min(-100_000).max(100_000);
const savedStateSchema = z.strictObject({
  version: z.literal(1),
  bounds: z.strictObject({
    x: pixels,
    y: pixels,
    width: pixels.positive(),
    height: pixels.positive(),
  }),
  maximized: z.boolean(),
  fullScreen: z.boolean(),
});

function overlap(
  a: Rectangle,
  b: Rectangle,
): { width: number; height: number } {
  return {
    width: Math.max(
      0,
      Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    ),
    height: Math.max(
      0,
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
    ),
  };
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);

/**
 * Decides where the window opens from what was saved last time and the screens
 * connected now (their work areas, i.e. without the taskbar).
 *
 * - Anything unreadable or out of range falls back to the default size, centred.
 * - The size is kept between the app's minimum and the screen it opens on.
 * - The saved position is reused only if enough of the window would still be visible on
 *   a connected screen (so an unplugged monitor cannot strand it off-screen); the window
 *   is then nudged fully onto that screen.
 */
export function placeWindow(
  saved: unknown,
  workAreas: readonly Rectangle[],
): WindowPlacement {
  const fallback: WindowPlacement = {
    ...defaultWindowSize,
    maximized: false,
    fullScreen: false,
  };
  const parsed = savedStateSchema.safeParse(saved);
  const primary = workAreas[0];
  if (!parsed.success || primary === undefined) return fallback;
  const { bounds, maximized, fullScreen } = parsed.data;

  // The screen showing most of the window, if it shows enough of it.
  let best: { area: Rectangle; visible: number } | undefined;
  for (const area of workAreas) {
    const shown = overlap(bounds, area);
    if (
      shown.width >= minimumVisible.width &&
      shown.height >= minimumVisible.height &&
      shown.width * shown.height > (best?.visible ?? 0)
    )
      best = { area, visible: shown.width * shown.height };
  }

  const area = best?.area ?? primary;
  const width = clamp(
    bounds.width,
    minimumWindowSize.width,
    Math.max(area.width, minimumWindowSize.width),
  );
  const height = clamp(
    bounds.height,
    minimumWindowSize.height,
    Math.max(area.height, minimumWindowSize.height),
  );
  if (best === undefined) return { width, height, maximized, fullScreen };
  return {
    x: clamp(bounds.x, area.x, area.x + area.width - width),
    y: clamp(bounds.y, area.y, area.y + area.height - height),
    width,
    height,
    maximized,
    fullScreen,
  };
}

/**
 * The smallest step, in device-independent pixels, that is a whole number of screen
 * pixels at this display scale: 1 at 100% and 200%, 2 at 150%, 4 at 125% and 175%.
 * Returns 1 if no step up to 20 fits.
 */
export function pixelGridStep(scaleFactor: number): number {
  for (let step = 1; step <= 20; step++) {
    const pixels = step * scaleFactor;
    if (Math.abs(pixels - Math.round(pixels)) < 1e-4) return step;
  }
  return 1;
}

/**
 * Moves a placement onto whole screen pixels for a display with this scale factor.
 *
 * Electron rounds a window's position and size to whole screen pixels when it opens it,
 * and when a value falls between pixels (x = 137 at 125% scaling is 171.25 px) the
 * rounding makes the window a few pixels bigger. Saving and reopening would then grow
 * the window on every launch (1012 → 1020 → 1028 px wide in a packaged build at 125%).
 * Values on the pixel grid round-trip exactly. The size never drops below the minimum.
 */
export function snapToPixelGrid(
  placement: WindowPlacement,
  scaleFactor: number,
): WindowPlacement {
  const step = pixelGridStep(scaleFactor);
  if (step === 1) return placement;
  const snap = (value: number) => Math.round(value / step) * step;
  const atLeast = (value: number, minimum: number) =>
    Math.max(snap(value), Math.ceil(minimum / step) * step);
  return {
    ...placement,
    ...(placement.x !== undefined && { x: snap(placement.x) }),
    ...(placement.y !== undefined && { y: snap(placement.y) }),
    width: atLeast(placement.width, minimumWindowSize.width),
    height: atLeast(placement.height, minimumWindowSize.height),
  };
}

/**
 * The window state file (`window-state.json` in the user profile). It holds only screen
 * coordinates, nothing sensitive. Writes are synchronous so the last state is saved even
 * when the app quits straight after the window closes, and go through a temporary file so
 * a crash never leaves a half-written file.
 */
export class WindowStateFile {
  constructor(private readonly filePath: string) {}

  /** The saved state as raw data (validated by {@link placeWindow}), or `undefined`. */
  load(): unknown {
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  }

  save(state: WindowState): void {
    const temporary = `${this.filePath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify({ version: 1, ...state, bounds: { ...state.bounds } }),
        'utf8',
      );
      renameSync(temporary, this.filePath);
    } catch {
      // Losing the window position is harmless; never fail the app over it.
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Nothing more to do: the next save overwrites or the file is ignored.
      }
    }
  }
}
