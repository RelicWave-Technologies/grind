/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Production API host baked in at build time (see apps/agent/.env.production). */
  readonly MAIN_VITE_API_URL?: string;
  /** Custom protocol scheme used for agent OAuth callbacks. */
  readonly MAIN_VITE_CALLBACK_SCHEME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
