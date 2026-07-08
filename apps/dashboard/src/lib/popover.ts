import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * Tiny popover positioning + dismiss hook used by TimePopover and TaskCombo.
 *
 * Why hand-rolled (no @floating-ui dep): the Edit Time dropdowns only need:
 *   - place the popover below the trigger; flip above when there isn't
 *     enough room beneath
 *   - dismiss on outside click / Esc / window scroll or resize
 *   - keep position constant while open (no live re-positioning — if the
 *     surface moves, we just close the popover so the user can re-open it
 *     at the new location; that's calmer than the alternative)
 *
 * Returns enough hooks for the consumer to wire up the trigger + popover
 * elements + an accessibility-correct `open` state.
 */

export interface PopoverState {
  open: boolean;
  setOpen: (next: boolean) => void;
  triggerRef: React.RefObject<HTMLElement>;
  popoverRef: React.RefObject<HTMLDivElement>;
  /** Inline style for the popover element. */
  popoverStyle: React.CSSProperties;
  /** "down" (default) or "up" when flipped. The popover should set
   *  data-flip={flip} on its root for the CSS to switch transform-origin. */
  flip: 'down' | 'up';
}

export interface PopoverRect {
  top: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface PopoverPosition {
  top: number;
  left: number;
  flip: 'down' | 'up';
}

interface PopoverOptions {
  /** Horizontal offset from the trigger's left edge. Default 0. */
  offsetX?: number;
  /** Vertical gap between trigger and popover, in px. Default 4. */
  gap?: number;
  /** Estimated popover height, for flip detection. Default 280. */
  estimatedHeight?: number;
  /** Called after the popover opens (e.g. to focus first item). */
  onOpen?: () => void;
}

const VIEWPORT_GUTTER = 8;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function computePopoverPosition(args: {
  trigger: PopoverRect;
  popover: { width: number; height: number };
  viewport: { width: number; height: number };
  offsetX?: number;
  gap?: number;
  gutter?: number;
}): PopoverPosition {
  const offsetX = args.offsetX ?? 0;
  const gap = args.gap ?? 4;
  const gutter = args.gutter ?? VIEWPORT_GUTTER;
  const spaceBelow = args.viewport.height - args.trigger.bottom - gap - gutter;
  const spaceAbove = args.trigger.top - gap - gutter;
  const flip = spaceBelow < args.popover.height && spaceAbove > spaceBelow ? 'up' : 'down';
  const preferredTop = flip === 'down'
    ? args.trigger.bottom + gap
    : args.trigger.top - gap - args.popover.height;
  const preferredLeft = args.trigger.left + offsetX;

  return {
    top: clamp(preferredTop, gutter, args.viewport.height - args.popover.height - gutter),
    left: clamp(preferredLeft, gutter, args.viewport.width - args.popover.width - gutter),
    flip,
  };
}

/**
 * Singleton signal so only one popover is open at a time across the page.
 * Each instance subscribes on mount; the most recently opened one wins.
 */
let openInstance: { close: () => void } | null = null;

export function usePopover(opts: PopoverOptions = {}): PopoverState {
  const { offsetX = 0, gap = 4, estimatedHeight = 280, onOpen } = opts;
  const [open, setOpenState] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; flip: 'down' | 'up' }>({
    top: 0, left: 0, flip: 'down',
  });
  const triggerRef = useRef<HTMLElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closerRef = useRef<() => void>(() => setOpenState(false));
  const scrollDismissArmedRef = useRef(false);

  // Keep closerRef up to date so the singleton can close us.
  useEffect(() => {
    closerRef.current = () => setOpenState(false);
  });

  // Compute position whenever we transition to open.
  useLayoutEffect(() => {
    if (!open) return;
    const trig = triggerRef.current;
    if (!trig) return;
    const triggerRect = trig.getBoundingClientRect();
    const popoverRect = popoverRef.current?.getBoundingClientRect();
    const popover = {
      width: Math.max(1, popoverRect?.width ?? 280),
      height: Math.max(1, popoverRect?.height ?? estimatedHeight),
    };
    setPos(computePopoverPosition({
      trigger: triggerRect,
      popover,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      offsetX,
      gap,
    }));
  }, [open, gap, offsetX, estimatedHeight]);

  const setOpen = useCallback((next: boolean) => {
    setOpenState((cur) => {
      if (next === cur) return cur;
      if (next) {
        if (openInstance && openInstance.close !== closerRef.current) openInstance.close();
        openInstance = { close: closerRef.current };
        if (onOpen) requestAnimationFrame(onOpen);
      } else if (openInstance && openInstance.close === closerRef.current) {
        openInstance = null;
      }
      return next;
    });
  }, [onOpen]);

  // Dismiss on outside mousedown, Esc, scroll, resize.
  useEffect(() => {
    if (!open) return;
    scrollDismissArmedRef.current = false;
    let settleFrame = 0;
    const armScrollDismiss = requestAnimationFrame(() => {
      settleFrame = requestAnimationFrame(() => {
        scrollDismissArmedRef.current = true;
      });
    });
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      // Let another Edit Time popover trigger handle the click itself. Its
      // `setOpen(true)` will close this instance through the singleton, which
      // keeps switching between chips a one-click action.
      if (target instanceof Element && target.closest('.et-chip-trigger[aria-haspopup]')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Dismiss on OUTSIDE scrolls (the page or any scrollable ancestor moved
    // so the trigger would be at a stale position). Scrolls that originate
    // INSIDE the popover (e.g. the time list scrolling itself, or the
    // initial scrollIntoView on the active cell) must NOT dismiss — that
    // was the "popover came and disappeared" bug.
    const onScroll = (e: Event) => {
      if (!scrollDismissArmedRef.current) return;
      const target = e.target as Node | null;
      if (target && popoverRef.current && popoverRef.current.contains(target)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(armScrollDismiss);
      cancelAnimationFrame(settleFrame);
      scrollDismissArmedRef.current = false;
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, setOpen]);

  const popoverStyle: React.CSSProperties = useMemo(() => {
    return { top: pos.top, left: pos.left };
  }, [pos.top, pos.left]);

  return { open, setOpen, triggerRef, popoverRef, popoverStyle, flip: pos.flip };
}
