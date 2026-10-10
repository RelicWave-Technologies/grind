/**
 * Whether a URL that came from somewhere else (the server's config, a deep
 * link) may be handed to shell.openExternal. openExternal launches whatever
 * handles the scheme — file:, smb:, a custom protocol, an app — so a bad or
 * tampered config value must never get that far. Only https, plus plain http
 * to this machine in development.
 */
export function isSafeExternalUrl(raw: string, opts: { allowLocalHttp?: boolean } = {}): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return url.hostname.length > 0;
  if (url.protocol === 'http:' && opts.allowLocalHttp) {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  }
  return false;
}
