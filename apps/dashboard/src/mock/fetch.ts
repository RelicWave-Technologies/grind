/**
 * Patches window.fetch so every /v1 request — `api()`, the silent refresh in
 * lib/api.ts, and the raw CSV/XLSX fetches — is answered in the browser.
 * Anything else (Vite modules, images, HMR) goes to the real fetch.
 *
 * Plain `<a href="/v1/...">` downloads are caught too, so the file handed over
 * comes from the same mock data the screen shows.
 */
import { respond } from './dispatch';

function toUrl(input: RequestInfo | URL): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(raw, window.location.href);
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  let text: string | undefined;
  if (typeof init?.body === 'string') text = init.body;
  else if (init?.body === undefined && input instanceof Request) text = await input.clone().text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function installFetch(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = toUrl(input);
    if (!url.pathname.startsWith('/v1/')) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    return respond(method, url, await readBody(input, init));
  };

  // `<a href="/v1/...">` (timesheet CSV, installer downloads) is a navigation,
  // not a fetch. Serve it from the mock and hand the file over as a download.
  document.addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = new URL(anchor.href, window.location.href);
      if (!url.pathname.startsWith('/v1/')) return;
      event.preventDefault();
      void (async () => {
        const res = await window.fetch(url.href);
        const disposition = res.headers.get('Content-Disposition') ?? '';
        const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? url.pathname.split('/').pop() ?? 'download';
        const blobUrl = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      })();
    },
    true,
  );
}
