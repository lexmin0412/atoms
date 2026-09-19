import { useEffect, useRef, useState } from 'react';

/**
 * 思考内容展示：流式时展开并显示「思考中…」，结束后自动折叠为「已思考」。
 * 解决模型思考阶段「一直静默、无反馈」的问题。
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
    <div className="my-2 rounded-lg border border-neutral-200 bg-neutral-50/60 text-sm dark:border-neutral-800 dark:bg-neutral-900/50">
      <button
        onClick={() =>
          streaming ? setCollapsedWhileStreaming((v) => !v) : setExpandedAfter((v) => !v)
        }
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-neutral-500"
      >
        <span className="text-neutral-400">{open ? '▾' : '▸'}</span>
        <span>{streaming ? '思考中…' : '已思考'}</span>
        {streaming && (
          <span className="ml-0.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        )}
      </button>
      {open && (
        <div
          ref={boxRef}
          className="max-h-60 overflow-auto border-t border-neutral-200 px-3 py-2 text-xs whitespace-pre-wrap text-neutral-500 dark:border-neutral-800"
        >
          {text || '…'}
        </div>
      )}
    </div>
  );
}
