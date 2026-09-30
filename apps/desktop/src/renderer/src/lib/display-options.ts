import { useCallback, useState } from 'react';
import {
  defaultDisplayOptions,
  displayOptionsSchema,
  type DisplayOptions,
} from '@swyft/contracts';

/**
 * Display toggles are a per-device presentation convenience (like column widths), so
 * they live in localStorage rather than a server table. Storage may be unavailable or
 * hold stale/tampered data; both fall back to defaults.
 */
const storageKey = 'swyft.display-options.v1';

/** Saved display options, validated; anything missing or invalid falls back to the defaults. */
export function readDisplayOptions(
  storage: Storage | undefined,
): DisplayOptions {
  try {
    const raw = storage?.getItem(storageKey);
    if (!raw) return defaultDisplayOptions;
    const parsed = displayOptionsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? withFrequency(parsed.data) : defaultDisplayOptions;
  } catch {
    return defaultDisplayOptions;
  }
}

/** At least one payment frequency is always shown. */
function withFrequency(options: DisplayOptions): DisplayOptions {
  const { monthly, fortnightly, weekly } = options.frequencies;
  return monthly || fortnightly || weekly
    ? options
    : { ...options, frequencies: { ...options.frequencies, monthly: true } };
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Display options for this device, persisted to local storage as they change. */
export function useDisplayOptions(): readonly [
  DisplayOptions,
  (next: DisplayOptions) => void,
] {
  const [options, setOptions] = useState(() =>
    readDisplayOptions(safeStorage()),
  );
  const change = useCallback((next: DisplayOptions) => {
    const valid = withFrequency(next);
    setOptions(valid);
    try {
      safeStorage()?.setItem(storageKey, JSON.stringify(valid));
    } catch {
      // Preferences still apply for this session.
    }
  }, []);
  return [options, change] as const;
}
