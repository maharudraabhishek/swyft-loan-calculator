import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiFailure, ApiResult } from '@swyft/contracts';

/**
 * Server data owned by one screen. `data` survives a reload or failed reload of the same
 * key so the screen can keep showing the last known values next to the error (marked
 * stale by the caller); it never carries over to a different key (e.g. another deal).
 */
export type Resource<T> =
  | { readonly status: 'loading'; readonly data?: T }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly data?: T; readonly error: ApiFailure };

export interface ResourceHandle<T> {
  readonly resource: Resource<T>;
  readonly reload: () => void;
  /** Applies a confirmed server change locally (e.g. a saved note) without refetching. */
  readonly update: (change: (current: T) => T) => void;
}

/**
 * Loads `load()` whenever `key` changes or `reload()` is called. Only the newest request
 * may publish, so a slow earlier response can never overwrite newer data, and nothing
 * is set after unmount.
 */
export function useResource<T>(
  load: () => Promise<ApiResult<T>>,
  key: string,
): ResourceHandle<T> {
  const [resource, setResource] = useState<Resource<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const loadedKey = useRef(key);

  useEffect(() => {
    let current = true;
    const sameKey = loadedKey.current === key;
    loadedKey.current = key;
    setResource((previous) =>
      previous.data === undefined || !sameKey
        ? { status: 'loading' }
        : { status: 'loading', data: previous.data },
    );
    loadRef
      .current()
      .then((result) => {
        if (!current) return;
        setResource((previous) =>
          result.ok
            ? { status: 'ready', data: result.data }
            : {
                status: 'error',
                error: result.error,
                ...(previous.data !== undefined && { data: previous.data }),
              },
        );
      })
      .catch(() => {
        if (current)
          setResource({
            status: 'error',
            error: {
              kind: 'server',
              message: 'The desktop app could not complete the request.',
            },
          });
      });
    return () => {
      current = false;
    };
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const update = useCallback((change: (current: T) => T) => {
    setResource((previous) =>
      previous.data === undefined
        ? previous
        : { ...previous, data: change(previous.data) },
    );
  }, []);
  return { resource, reload, update };
}
