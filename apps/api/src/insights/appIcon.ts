import { prisma } from '@grind/db';

/**
 * Inline real agent-extracted icons (stored per bundle id) as `data:` URLs,
 * keyed by bundle id. Inlining avoids a separate cross-origin image endpoint;
 * the top-N apps make the payload small. Apps without a stored icon fall back
 * to the brand map below.
 */
export async function storedIconDataUrls(bundles: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(bundles.filter((b): b is string => !!b))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.appIcon.findMany({
    where: { bundleId: { in: ids } },
    select: { bundleId: true, png: true },
  });
  return new Map(rows.map((r) => [r.bundleId, `data:image/png;base64,${Buffer.from(r.png).toString('base64')}`]));
}

/** Real stored icon if we have one, else domain favicon / brand-map URL, else null. */
export function resolveAppIcon(app: string, bundle: string | null, stored: Map<string, string>, domain?: string | null): string | null {
  if (domain) return siteFaviconUrl(domain);
  if (bundle && stored.has(bundle)) return stored.get(bundle) ?? null;
  return appIconUrl(app, bundle);
}

export function siteFaviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

export function appIconUrl(app: string, bundle: string | null): string | null {
  const haystack = `${app} ${bundle ?? ''}`.toLowerCase();
  const simple = (slug: string, color?: string) =>
    `https://cdn.simpleicons.org/${slug}${color ? `/${color}` : ''}`;
  if (haystack.includes('electron')) return simple('electron', '47848F');
  if (haystack.includes('dia')) return 'https://www.google.com/s2/favicons?domain=diabrowser.com&sz=64';
  if (haystack.includes('chrome')) return simple('googlechrome', '4285F4');
  if (haystack.includes('safari')) return simple('safari', '006CFF');
  if (haystack.includes('firefox')) return simple('firefoxbrowser', 'FF7139');
  if (haystack.includes('slack')) return simple('slack', '4A154B');
  if (haystack.includes('figma')) return simple('figma', 'F24E1E');
  if (haystack.includes('visual studio code') || haystack.includes('vscode')) return simple('visualstudiocode', '007ACC');
  if (haystack.includes('cursor')) return 'https://www.cursor.com/favicon.ico';
  if (haystack.includes('notion')) return simple('notion', '000000');
  if (haystack.includes('linear')) return simple('linear', '5E6AD2');
  if (haystack.includes('zoom')) return simple('zoom', '0B5CFF');
  if (haystack.includes('github')) return simple('github', '181717');
  return null;
}
