/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  /** '1' under `dev:mock` — the API is mocked in the browser (src/mock). */
  readonly VITE_MOCK?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
