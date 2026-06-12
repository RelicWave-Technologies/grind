import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { cx } from './util';

/* §5.9 Field (+ Input / Select / Textarea / Toggle / Checkbox / Radio).
   <Field> wraps any control with an eyebrow label, hint, or error. Controls
   share the .ui-control base: one height, hairline border, accent focus ring. */

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}

export function Field({ label, hint, error, className, children, ...rest }: FieldProps) {
  return (
    <div className={cx('ui-field', className)} {...rest}>
      {label != null && <span className="ui-field__label ui-t-eyebrow">{label}</span>}
      {children}
      {error != null ? (
        <span className="ui-field__error ui-t-small" role="alert">{error}</span>
      ) : (
        hint != null && <span className="ui-field__hint ui-t-small">{hint}</span>
      )}
    </div>
  );
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { error, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx('ui-control', error && 'is-error', className)}
      aria-invalid={error || undefined}
      {...rest}
    />
  );
});

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
  children: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { error, className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cx('ui-control', 'ui-select', error && 'is-error', className)}
      aria-invalid={error || undefined}
      {...rest}
    >
      {children}
    </select>
  );
});

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { error, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cx('ui-control', error && 'is-error', className)}
      aria-invalid={error || undefined}
      {...rest}
    />
  );
});

/* Toggle — a switch. Controlled via checked/onChange; rendered as a checkbox
   input for accessibility (role=switch). */
export interface ToggleProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export const Toggle = forwardRef<HTMLInputElement, ToggleProps>(function Toggle(
  { checked, onChange, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type="checkbox"
      role="switch"
      className={cx('ui-toggle', className)}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      {...rest}
    />
  );
});

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} type="checkbox" className={cx('ui-checkbox', className)} {...rest} />;
});

export type RadioProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} type="radio" className={cx('ui-radio', className)} {...rest} />;
});
