const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The API origin is fixed at build time (`MAIN_VITE_API_BASE_URL`, a public value; see
 * `apps/desktop/.env.production`) and validated here. Packaged builds accept only an
 * explicitly configured HTTPS origin; development may fall back to the local API.
 */
export function resolveApiBaseUrl(
  configured: string | undefined,
  packaged: boolean,
): string {
  if (packaged && !configured)
    throw new Error('MAIN_VITE_API_BASE_URL must be set for packaged builds');
  const url = new URL(
    configured && configured.length > 0 ? configured : 'http://127.0.0.1:8080',
  );
  const allowed =
    url.protocol === 'https:' ||
    (!packaged && url.protocol === 'http:' && loopbackHosts.has(url.hostname));
  if (
    !allowed ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      packaged
        ? 'MAIN_VITE_API_BASE_URL must be an https origin in packaged builds'
        : 'MAIN_VITE_API_BASE_URL must be an https origin (or http loopback for development)',
    );
  return url.origin;
}
