/**
 * Timo Dashboard UI kit — the "Quiet Datasheet" component system.
 * Single source of truth: ./SYSTEM.md. Styles: ./system.css (wired globally in
 * src/main.tsx). Every one of the 13 pages composes from these primitives;
 * a page contributes layout only — never a color, font, radius, or shadow.
 *
 *   import { Page, PageHeader, Card, Stat, StatRow, Table, Button } from '../ui';
 */

// ── Shared types ────────────────────────────────────────────────────────────
export type { Status, Rail } from './util';

// ── §5.1 / §5.2 — frame + header ───────────────────────────────────────────
export { Page, PageHeader } from './Page';
export type { PageProps, PageHeaderProps } from './Page';

// ── §5.3 — surface container ────────────────────────────────────────────────
export { Card } from './Card';
export type { CardProps, CardVariant } from './Card';

// ── §5.4 — metric pattern ───────────────────────────────────────────────────
export { Stat, StatRow } from './Stat';
export type { StatProps, StatRowProps, StatDelta } from './Stat';

// ── §5.5 — data grid ────────────────────────────────────────────────────────
export { Table, THead, Tbody, Th, Tr, Td } from './Table';
export type {
  TableProps,
  ThProps,
  TrProps,
  TdProps,
  TableDensity,
  Align,
} from './Table';

// ── §5.6 — lightweight row stack ────────────────────────────────────────────
export { List, ListRow } from './List';
export type { ListProps, ListRowProps } from './List';

// ── §5.7 — buttons ──────────────────────────────────────────────────────────
export { Button, IconButton } from './Button';
export type { ButtonProps, IconButtonProps, ButtonVariant, ButtonSize } from './Button';

// ── §5.8 — view switching ───────────────────────────────────────────────────
export { Tabs, Segmented } from './Tabs';
export type { TabsProps, SegmentedProps, TabItem } from './Tabs';

// ── §5.9 — forms ────────────────────────────────────────────────────────────
export { Field, Input, Select, Textarea, Toggle, Checkbox } from './Field';
export type {
  FieldProps,
  InputProps,
  SelectProps,
  TextareaProps,
  ToggleProps,
  CheckboxProps,
} from './Field';

// ── §5.10 — status & labels ─────────────────────────────────────────────────
export { Tag } from './Tag';
export type { TagProps } from './Tag';

// ── §5.11 — people ──────────────────────────────────────────────────────────
export { Avatar, AvatarGroup, Identity } from './Avatar';
export type { AvatarProps, AvatarGroupProps, IdentityProps, AvatarSize } from './Avatar';

// ── §5.12 — control clusters ────────────────────────────────────────────────
export { Toolbar, DateStepper } from './Toolbar';
export type { ToolbarProps, DateStepperProps } from './Toolbar';

// ── §5.13 / §5.15 — empty + inline notices ──────────────────────────────────
export { EmptyState, Banner } from './Feedback';
export type { EmptyStateProps, BannerProps, BannerStatus } from './Feedback';

// ── §5.14 — loading ─────────────────────────────────────────────────────────
export { Skeleton, SkeletonTable, SkeletonStat } from './Loading';
export type { SkeletonProps } from './Loading';

// ── §5.16 — modal ───────────────────────────────────────────────────────────
export { Modal } from './Overlay';
export type { ModalProps } from './Overlay';

// ── §5.17 — app chrome ──────────────────────────────────────────────────────
export { AppShell, Sidebar, SidebarBrand, NavSection, NavItem } from './Shell';
export type {
  AppShellProps,
  SidebarProps,
  SidebarBrandProps,
  NavItemProps,
} from './Shell';
