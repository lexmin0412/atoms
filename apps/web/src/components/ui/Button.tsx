import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cx } from '../../lib/cx';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'danger-solid';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-foreground hover:brightness-[1.06] active:brightness-95 shadow-[0_1px_0_oklch(0_0_0/6%)]',
  secondary: 'bg-muted text-foreground hover:bg-border',
  outline: 'border border-border text-foreground hover:bg-muted',
  ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
  danger: 'border border-border text-danger hover:bg-danger/10',
  'danger-solid': 'bg-danger text-white hover:brightness-110',
};

const SIZE: Record<Size, string> = {
  // 移动端加大触控高度（>=36px），lg 起回到紧凑尺寸
  sm: 'h-9 px-3 text-[13px] gap-1.5 rounded-xs lg:h-7 lg:px-2.5 lg:text-[12.5px]',
  md: 'h-10 px-4 text-[13.5px] gap-2 rounded-sm lg:h-9 lg:px-3.5',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
    >
      {loading && (
        <span className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}
