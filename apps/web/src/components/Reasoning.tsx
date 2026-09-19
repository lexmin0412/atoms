import { useEffect, useRef, useState } from 'react';

/**
 * 思考内容展示：流式时展开并显示「思考中」，结束后自动折叠为「已思考」。
 * 展开状态由 props 派生，用户手动操作只记录在当前阶段内，避免 effect 级联渲染。
 */
export default function Reasoning({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [collapsedWhileStreaming, setCollapsedWhileStreaming] = useState(false);
  const [expandedAfter, setExpandedAfter] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const open = streaming ? !collapsedWhileStreaming : expandedAfter;

  // 流式中自动滚到底部（同步 DOM 的真实副作用）
  useEffect(() => {
    if (streaming && open && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [text, streaming, open]);

  return (
    <div className="panel my-2 overflow-hidden">
      <button
        onClick={() =>
          streaming ? setCollapsedWhileStreaming((v) => !v) : setExpandedAfter((v) => !v)
        }
        className="blueprint-head hover:bg-muted/50 flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
      >
        <span className="w-2.5 shrink-0">{open ? '▾' : '▸'}</span>
        <span>{streaming ? '思考中' : '已思考'}</span>
        {streaming && (
          <span
            className="ml-0.5 inline-block size-1.5 animate-pulse rounded-full"
            style={{ background: 'var(--warn)' }}
          />
        )}
      </button>
      {open && (
        <div
          ref={boxRef}
          className="border-border bg-background/50 text-muted-foreground max-h-60 overflow-auto border-t px-2.5 py-2 text-[11.5px] leading-relaxed whitespace-pre-wrap"
        >
          {text || '…'}
        </div>
      )}
    </div>
  );
}
