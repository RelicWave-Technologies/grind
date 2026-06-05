import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from './util';
import { IconButton } from './Button';

/* §5.12 Toolbar — the header / table-top control cluster. Keeps every page's
   controls aligned and ordered. Canonical order:
   Tabs/Segmented → Selects → DateStepper → primary Button. */
export interface ToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Toolbar({ children, className, ...rest }: ToolbarProps) {
  return (
    <div className={cx('ui-toolbar', className)} role="toolbar" {...rest}>
      {children}
    </div>
  );
}

/** A hairline divider for grouping controls inside a Toolbar. */
export function ToolbarDivider({ className, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx('ui-toolbar__divider', className)} aria-hidden {...rest} />;
}

/* DateStepper — two IconButtons around a mono date pill. */
export interface DateStepperProps {
  value: ReactNode;
  onPrev: () => void;
  onNext: () => void;
  /** Disable the forward control (e.g. at "today"). */
  nextDisabled?: boolean;
  prevDisabled?: boolean;
  prevLabel?: string;
  nextLabel?: string;
  className?: string;
}

export function DateStepper({
  value,
  onPrev,
  onNext,
  nextDisabled,
  prevDisabled,
  prevLabel = 'Previous',
  nextLabel = 'Next',
  className,
}: DateStepperProps) {
  return (
    <div className={cx('ui-date-stepper', className)}>
      <IconButton
        icon={<ChevronLeft size={16} strokeWidth={1.8} />}
        aria-label={prevLabel}
        variant="secondary"
        onClick={onPrev}
        disabled={prevDisabled}
      />
      <span className="ui-date-stepper__pill">{value}</span>
      <IconButton
        icon={<ChevronRight size={16} strokeWidth={1.8} />}
        aria-label={nextLabel}
        variant="secondary"
        onClick={onNext}
        disabled={nextDisabled}
      />
    </div>
  );
}
