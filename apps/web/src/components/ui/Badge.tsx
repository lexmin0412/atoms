import type { ReactNode } from 'react';

import { cx } from '../../lib/cx';

type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger';

const TONE: Record<Tone, string> = {
  neutral: 'border-border text-muted-foreground',
  accent: 'border-accent/35 text-accent bg-accent/8',
  success: 'border-success/35 text-success bg-success/8',
  warn: 'border-warn/35 text-warn bg-warn/10',
  danger: 'border-danger/35 text-danger bg-danger/8',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-xs border px-1.5 py-0.5 text-[11.5px] leading-none font-medium',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
