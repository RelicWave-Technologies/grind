import { useState } from 'react';
import { cx } from '../ui/util';

export function AppIcon({
  name,
  iconUrl,
  className,
}: {
  name: string;
  iconUrl?: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initial = name.trim().slice(0, 1).toUpperCase() || '?';

  return (
    <span className={cx('ui-app-icon', className)} aria-hidden>
      {iconUrl && !failed ? (
        <img src={iconUrl} alt="" onError={() => setFailed(true)} />
      ) : (
        <span className="ui-app-icon__initial ui-t-eyebrow">{initial}</span>
      )}
    </span>
  );
}
