import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { cx } from '../../lib/cx';
import { Button } from './Button';
import { Field } from './Field';

/** 危险操作的确认按钮（实心红） */
function DangerButton({
  children,
  loading,
  onClick,
}: {
  children: ReactNode;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="sm" variant="danger-solid" loading={loading} onClick={onClick}>
      {children}
    </Button>
  );
}

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

/**
 * 内联二次确认（Popover）。用法：
 *   <PopConfirm title="发布应用？" onConfirm={publish}><Button>发布</Button></PopConfirm>
 * 触发元素的 onClick 由本组件接管，确认后才执行 onConfirm。
 */
export function PopConfirm({
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  align = 'right',
  onConfirm,
  children,
}: {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  align?: 'left' | 'right';
  onConfirm: () => void | Promise<void>;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => setOpen(false);
  const ref = useDismiss(open, close);

  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        onClick: (e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        },
        'aria-expanded': open,
      })
    : children;

  return (
    <span className="relative inline-flex" ref={ref}>
      {trigger}
      {open && (
        <div
          role="dialog"
          className={cx(
            'panel-raised absolute top-full z-50 mt-1.5 w-64 p-3 text-left',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          <p className="text-[12.5px] font-medium">{title}</p>
          {description && (
            <p className="text-muted-foreground mt-1 text-[11.5px] leading-relaxed">
              {description}
            </p>
          )}
          <div className="mt-3 flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={close}>
              {cancelText}
            </Button>
            {danger ? (
              <DangerButton
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onConfirm();
                  } finally {
                    setBusy(false);
                    close();
                  }
                }}
              >
                {confirmText}
              </DangerButton>
            ) : (
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onConfirm();
                  } finally {
                    setBusy(false);
                    close();
                  }
                }}
              >
                {confirmText}
              </Button>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

/** 模态二次确认（用于菜单等不便内联的场景） */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '删除',
  cancelText = '取消',
  danger = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const ref = useDismiss(open, onCancel);
  if (!open) return null;

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-[1px]">
      <div
        ref={ref as unknown as React.RefObject<HTMLDivElement>}
        role="alertdialog"
        className="panel-raised w-96 p-5"
      >
        <p className="text-[14px] font-medium">{title}</p>
        {description && (
          <p className="text-muted-foreground mt-1.5 text-[12.5px] leading-relaxed">
            {description}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {cancelText}
          </Button>
          {danger ? (
            <DangerButton loading={busy} onClick={confirm}>
              {confirmText}
            </DangerButton>
          ) : (
            <Button size="sm" variant="primary" loading={busy} onClick={confirm}>
              {confirmText}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 输入式弹窗（重命名等）—— 受控：value/onChange 由调用方持有 */
export function PromptDialog({
  open,
  title,
  description,
  value,
  onChange,
  placeholder,
  confirmText = '确定',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  confirmText?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-[1px]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="panel-raised w-96 p-5"
      >
        <p className="text-[14px] font-medium">{title}</p>
        {description && (
          <p className="text-muted-foreground mt-1.5 mb-3 text-[12.5px] leading-relaxed">
            {description}
          </p>
        )}
        <div className={description ? '' : 'mt-3'}>
          <Field
            autoFocus
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onCancel()}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={busy}
            disabled={!value.trim()}
          >
            {confirmText}
          </Button>
        </div>
      </form>
    </div>
  );
}
