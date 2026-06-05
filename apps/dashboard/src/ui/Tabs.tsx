import type { ReactNode } from 'react';
import { cx } from './util';

/* §5.8 Tabs (underline) + Segmented (track+thumb). Two patterns, never mixed
   for one job: Tabs switch PAGE SECTIONS; Segmented switches VIEW/RANGE. */

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
}

export interface TabsProps<V extends string> {
  items: ReadonlyArray<TabItem<V>>;
  value: V;
  onChange: (value: V) => void;
  className?: string;
  'aria-label'?: string;
}

export function Tabs<V extends string>({ items, value, onChange, className, ...rest }: TabsProps<V>) {
  return (
    <div className={cx('ui-tabs', className)} role="tablist" {...rest}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={it.value === value}
          className={cx('ui-tab', it.value === value && 'is-active')}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export interface SegmentedProps<V extends string> {
  items: ReadonlyArray<TabItem<V>>;
  value: V;
  onChange: (value: V) => void;
  size?: 'sm' | 'lg';
  className?: string;
  'aria-label'?: string;
}

export function Segmented<V extends string>({
  items,
  value,
  onChange,
  size = 'sm',
  className,
  ...rest
}: SegmentedProps<V>) {
  return (
    <div className={cx('ui-seg', size === 'lg' && 'ui-seg--lg', className)} role="tablist" {...rest}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={it.value === value}
          className={cx('ui-seg__item', it.value === value && 'is-active')}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
