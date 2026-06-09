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
