import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cx } from '../../lib/cx';

/** 图标按钮 + 悬浮文字提示（自定义 Tooltip，不走原生 title 的延迟） */
export function IconButton({
  label,
  icon,
  side = 'bottom',
  className,
  ...rest
}: {
  label: string;
  icon: ReactNode;
  side?: 'bottom' | 'left';
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      aria-label={label}
      className={cx(
        'group/ib relative grid size-7 shrink-0 place-items-center rounded-xs transition-colors',
        'text-muted-foreground hover:bg-muted hover:text-foreground',
        'disabled:pointer-events-none disabled:opacity-40',
        className,
      )}
    >
      {icon}
      <span
        role="tooltip"
        className={cx(
          'panel-raised pointer-events-none absolute z-50 hidden px-1.5 py-1 text-[11.5px] whitespace-nowrap text-foreground group-hover/ib:block',
          side === 'bottom'
            ? 'top-full left-1/2 mt-1.5 -translate-x-1/2'
            : 'top-1/2 right-full mr-1.5 -translate-y-1/2',
        )}
      >
        {label}
      </span>
    </button>
  );
}
