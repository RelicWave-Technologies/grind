import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { cx } from './util';
import { Spinner } from './Loading';

/* §5.7 Button — the only button. One primary fill per viewport.
   Flat variants: no gradient/glow/shadow. The kit exposes variant/size/state
   only — never props that alter the palette. */
export type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  /** Leading icon (12–16px line-art). Gap is fixed at --ui-sp-2. */
  icon?: ReactNode;
  /** Shows an inline spinner and disables interaction; label stays for layout. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    block,
    icon,
    loading,
    disabled,
    className,
    children,
    type,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cx(
        'ui-btn',
        `ui-btn--${variant}`,
        `ui-btn--${size}`,
        block && 'ui-btn--block',
        loading && 'is-loading',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {icon != null && <span className="ui-btn__icon">{icon}</span>}
      <span className="ui-btn__label">{children}</span>
      {loading && (
        <span className="ui-btn__spin">
          <Spinner size={14} />
        </span>
      )}
    </button>
  );
});

/* IconButton — a Button with an icon and no label: square, ghost by default.
   Requires an accessible label via `aria-label`. */
export interface IconButtonProps
  extends Omit<ButtonProps, 'icon' | 'block' | 'children'> {
  icon: ReactNode;
  'aria-label': string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ icon, variant = 'ghost', size = 'md', loading, disabled, className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={cx('ui-btn', 'ui-btn--icon', `ui-btn--${variant}`, `ui-btn--${size}`, loading && 'is-loading', className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...rest}
      >
        <span className="ui-btn__icon">{icon}</span>
        {loading && (
          <span className="ui-btn__spin">
            <Spinner size={14} />
          </span>
        )}
      </button>
    );
  },
);
