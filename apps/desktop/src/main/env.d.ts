/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public API origin embedded at build time, e.g. https://swyft-api-xxxx.a.run.app */
  readonly MAIN_VITE_API_BASE_URL?: string;
}
