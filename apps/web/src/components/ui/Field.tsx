import type { InputHTMLAttributes, ReactNode } from 'react';

import { cx } from '../../lib/cx';

export function Field({
  label,
  hint,
  className,
  ...rest
}: {
  label?: string;
  hint?: ReactNode;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      {label && (
        <span className="text-muted-foreground mb-1.5 block text-[12px] font-medium">
          {label}
        </span>
      )}
      <input
        {...rest}
        className={cx(
          'h-9 w-full rounded-sm border border-border bg-surface px-3 text-[13.5px] text-foreground',
          'placeholder:text-muted-foreground/75 transition-colors',
          'hover:border-border-strong focus:border-ring focus:outline-none',
          className,
        )}
      />
      {hint && (
        <span className="text-muted-foreground mt-1.5 block text-[12px]">{hint}</span>
      )}
    </label>
  );
}
