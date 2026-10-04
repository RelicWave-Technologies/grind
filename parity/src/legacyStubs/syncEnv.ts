// `env.ts` as auth.ts imports it. Live bindings, so a scenario can vary them.
export let API_URL = 'http://localhost:4000';
export let CALLBACK_SCHEME: 'grind' | 'timo' = 'timo';
export function setEnv(apiUrl: string, scheme: 'grind' | 'timo'): void {
  API_URL = apiUrl;
  CALLBACK_SCHEME = scheme;
}
