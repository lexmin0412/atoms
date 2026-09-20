import { cx } from '../../lib/cx';

export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

export function Segmented<T extends string>({
  items,
  value,
  onChange,
  className,
}: {
  items: SegmentedItem<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cx(
        'inline-flex items-center gap-0.5 rounded-sm border border-border bg-muted/60 p-0.5',
        className,
      )}
    >
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.value)}
            className={cx(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xs px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors sm:h-6.5',
              active
                ? 'bg-surface text-foreground shadow-[0_1px_2px_oklch(0_0_0/8%)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {it.icon}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
