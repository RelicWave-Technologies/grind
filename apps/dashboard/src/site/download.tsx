import { useState } from 'react';
import { agentDownloadUrl } from '../lib/downloads';

const RELEASES = 'https://github.com/RelicWave-Technologies/grind/releases/latest';

export interface DownloadLink {
  label: string;
  short: string;
  href: string;
  icon: string | null;
  external: boolean;
}

/**
 * The OS-aware download button: Mac and Windows visitors get their own build,
 * from the same endpoint the in-app sidebar uses (it 302s to the current
 * signed installer, so the click downloads instead of detouring via GitHub).
 */
export function useDownload(): DownloadLink {
  const [os] = useState<'mac' | 'win' | null>(() => {
    const probe = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
    if (/Mac|iPhone|iPad/i.test(probe)) return 'mac';
    if (/Win/i.test(probe)) return 'win';
    return null;
  });
  if (os === 'mac') return { label: 'Download for Mac', short: 'Download', href: agentDownloadUrl('mac'), icon: '/brand/apple.svg', external: false };
  if (os === 'win') return { label: 'Download for Windows', short: 'Download', href: agentDownloadUrl('windows'), icon: '/brand/windows.svg', external: false };
  return { label: 'Get Timo', short: 'Get Timo', href: RELEASES, icon: null, external: true };
}

export function DownloadButton({ link, size = 'md', tone = 'primary' }: { link: DownloadLink; size?: 'md' | 'lg'; tone?: 'primary' | 'light' }) {
  return (
    <a
      className={`site-btn site-btn--${tone}${size === 'lg' ? ' site-btn--lg' : ''}`}
      href={link.href}
      {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})}
    >
      {link.icon && <img className="site-btn-os" src={link.icon} alt="" width={15} height={15} />}
      {size === 'lg' ? link.label : link.short}
    </a>
  );
}
