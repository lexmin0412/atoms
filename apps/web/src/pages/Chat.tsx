import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import CreditsBadge from '../components/CreditsBadge';
import DatabaseView from '../components/DatabaseView';
import Reasoning from '../components/Reasoning';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { PopConfirm } from '../components/ui/confirm';
import { IconCopy, IconRefresh, IconRocket, IconSparkle } from '../components/ui/icons';
import { AtomsMark } from '../components/ui/Logo';
import { Segmented, type SegmentedItem } from '../components/ui/Segmented';
import { api } from '../lib/api';

// 懒加载：Streamdown + Shiki 体积较大，推迟到首条消息渲染时再加载
const Markdown = lazy(() => import('../components/Markdown'));
// 懒加载：CodeMirror + 各语言包体积较大，仅切到「文件」页时加载
const FileManager = lazy(() => import('../components/FileManager'));

const EXAMPLES = ['做一个番茄钟', '一个待办清单', '一个极简记账本', '一个数据看板'];

/** 分栏：对话宽度约束（px）与左侧最小宽度 */
const CHAT_MIN = 360;
const CHAT_MAX = 520;
const LEFT_MIN = 320;
const SPLIT_KEY = 'atoms:chat-width-ratio';

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function clampChatWidth(width: number, containerWidth: number) {
  const maxChat = Math.min(CHAT_MAX, Math.max(CHAT_MIN, containerWidth - LEFT_MIN));
  return Math.round(Math.min(Math.max(width, CHAT_MIN), maxChat));
}

function friendlyError(msg: string): string {
  // 注意：这几种是不同原因，别合并成一句话（否则用户不知道该怎么办）
  if (/积分已用完|额度会在下个周期/.test(msg)) {
    return '积分已用完，额度会在下个周期自动恢复。';
  }
  if (/当前运行中的应用较多|busy/.test(msg)) {
    return '当前并发已满（同时运行的应用较多），请等一会儿再试。';
  }
  if (/模型服务繁忙|额度不足/.test(msg)) {
    return '模型服务繁忙（上游限流），请稍后重试。';
  }
  if (/模型服务鉴权失败/.test(msg)) {
    return msg;
  }
  if (/连接中断|ECONNRESET|fetch failed|stream ended|timeout/i.test(msg)) {
    return '与模型服务的连接中断，请重试。';
  }
  if (/error|failed|fetch|network|stream|timeout/i.test(msg)) {
    return '模型服务暂时不可用，请重试。';
  }
  return msg;
}

type Part = {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  data?: unknown;
};

function summarize(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === 'run_command') return String(i.cmd ?? '');
  if (name === 'list_files') return '列出文件';
  if (typeof i.path === 'string') return i.path;
  return '';
}

function toolLabel(name: string): string {
  switch (name) {
    case 'write_file':
      return '写入文件';
    case 'edit_file':
      return '编辑文件';
    case 'read_file':
      return '读取文件';
    case 'list_files':
      return '列出文件';
    case 'run_command':
      return '执行命令';
    default:
      return name;
  }
}

function ToolCard({ name, part }: { name: string; part: Part }) {
  const [open, setOpen] = useState(false);
  const state = part.state ?? '';
  const running = state === 'input-streaming' || state === 'input-available';
  const failed = state === 'output-error';
  const out = part.output as Record<string, unknown> | undefined;
  const outputText =
    typeof out?.output === 'string'
      ? (out.output as string)
      : out
        ? JSON.stringify(out, null, 2)
        : '';
  const dot = running ? 'var(--warn)' : failed ? 'var(--danger)' : 'var(--success)';

  return (
    <div className="panel my-2 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-muted/50 flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
      >
        <span className="blueprint-head w-2.5 shrink-0">{open ? '▾' : '▸'}</span>
        <span className="blueprint-head text-foreground/80 shrink-0">
          {toolLabel(name)}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11.5px]">
          {summarize(name, part.input)}
        </span>
        <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-[11.5px]">
          <span
            className={'size-1.5 rounded-full' + (running ? ' animate-pulse' : '')}
            style={{ background: dot }}
          />
          {running ? '运行中' : failed ? '失败' : '完成'}
        </span>
      </button>
      {open && outputText && (
        <pre className="border-border bg-background/60 text-muted-foreground max-h-72 overflow-auto border-t px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
          {outputText}
        </pre>
      )}
    </div>
  );
}

function renderPart(part: Part, i: number, animating: boolean) {
  if (part.type === 'text' && part.text) {
    return (
      <Suspense key={i} fallback={<div className="whitespace-pre-wrap">{part.text}</div>}>
        <Markdown text={part.text} animating={animating} />
      </Suspense>
    );
  }
  if (part.type === 'reasoning' && part.text) {
    return <Reasoning key={i} text={part.text} streaming={animating} />;
  }
  const isTool = part.type === 'dynamic-tool' || part.type.startsWith('tool-');
  if (isTool) {
    const name =
      part.type === 'dynamic-tool' ? (part.toolName ?? 'tool') : part.type.slice(5);
    return <ToolCard key={i} name={name} part={part} />;
  }
  return null;
}

function creditsOf(parts: Part[]): {
  credits: number;
  budgetExceeded: boolean;
} | null {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const p = parts[i];
    if (p.type === 'data-credits' && p.data) {
      return p.data as { credits: number; budgetExceeded: boolean };
    }
  }
  return null;
}

function MessageFooter({
  parts,
  canRegenerate,
  onRegenerate,
}: {
  parts: Part[];
  canRegenerate: boolean;
  onRegenerate: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const c = creditsOf(parts);
  const text = parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text ?? '')
    .join('\n')
    .trim();

  if (!c && !text) return null;

  return (
    <div className="text-muted-foreground mt-2 flex items-center gap-3 text-[11.5px]">
      {c && <span className="tnum">本次消耗 {c.credits.toFixed(2)} 积分</span>}
      {c?.budgetExceeded && <Badge tone="warn">额度用尽，已中断</Badge>}
      <span
        className="border-border inline-flex items-center gap-1 rounded-xs border px-1.5 py-0.5 text-[10.5px]"
        title="由 Atoms Agent 生成"
      >
        <span
          className="size-1.5 rounded-full"
          style={{ background: 'var(--accent)' }}
          aria-hidden
        />
        Atoms
      </span>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/m:opacity-100 focus-within:opacity-100">
        {text && (
          <button
            onClick={() => {
              navigator.clipboard?.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="hover:bg-muted hover:text-foreground inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 transition-colors"
          >
            <IconCopy size={12} />
            {copied ? '已复制' : '复制'}
          </button>
        )}
        {canRegenerate && (
          <button
            onClick={onRegenerate}
            className="hover:bg-muted hover:text-foreground inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 transition-colors"
          >
            <IconRefresh size={12} />
            重新生成
          </button>
        )}
      </div>
    </div>
  );
}

function TerminalBlock({ cmd, text }: { cmd: string; text: string }) {
  return (
    <div className="panel my-2 overflow-hidden">
      <div className="blueprint-head border-border flex items-center gap-2 border-b px-2.5 py-1.5">
        <span style={{ color: 'var(--accent)' }}>$</span>
        <span className="text-foreground/75 truncate">{cmd}</span>
      </div>
      <pre className="bg-background/60 text-foreground/90 max-h-72 overflow-auto px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
        {text || '…'}
      </pre>
    </div>
  );
}

function renderParts(parts: Part[], animating: boolean) {
  const nodes: React.ReactNode[] = [];
  let cmd = '';
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      nodes.push(
        <TerminalBlock key={`t${nodes.length}`} cmd={cmd} text={buf.join('')} />,
      );
      buf = [];
      cmd = '';
    }
  };
  parts.forEach((part, i) => {
    if (part.type === 'data-command') {
      const d = (part.data ?? {}) as { cmd?: string; text?: string };
      if (d.cmd) cmd = d.cmd;
      buf.push(d.text ?? '');
      return;
    }
    flush();
    const n = renderPart(part, i, animating);
    if (n) nodes.push(n);
  });
  flush();
  return nodes;
}

export default function Chat() {
  const { id } = useParams<{ id: string }>();
  const [input, setInput] = useState('');
  const [fileVersion, setFileVersion] = useState(0);
  const [tab, setTab] = useState<'preview' | 'files' | 'database'>('preview');
  const [previewVersion, setPreviewVersion] = useState(0);
  const [previewSrc, setPreviewSrc] = useState('');
  /** 是否已有构建产物：null=未知（首次探测中）。没产物时不能渲染 iframe（会露出沙箱的 404 文本） */
  const [hasBuild, setHasBuild] = useState<boolean | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [deploy, setDeploy] = useState<{
    status: string;
    url?: string;
    firstTime?: boolean;
  } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [dbAvailable, setDbAvailable] = useState(false);
  const [projectTitle, setProjectTitle] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ---- 工作台 / 对话 分栏 ----
  const splitRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const isWide = useMediaQuery('(min-width: 1024px)');
  // 宽度基准必须来自容器本身（工作台被侧栏包裹后，window.innerWidth ≠ 容器宽）
  const [containerW, setContainerW] = useState(0);
  const [ratio, setRatio] = useState(() => {
    const saved = Number(
      typeof window === 'undefined' ? '' : window.localStorage.getItem(SPLIT_KEY),
    );
    return saved > 0 ? saved : 0;
  });
  const [userAdjusted, setUserAdjusted] = useState(() =>
    typeof window === 'undefined' ? false : !!window.localStorage.getItem(SPLIT_KEY),
  );

  const transport = useMemo(
    () => new DefaultChatTransport({ api: `/api/projects/${id}/chat` }),
    [id],
  );
  const { messages, sendMessage, status, error, setMessages, stop, regenerate } = useChat(
    { transport },
  );

  const busy = status === 'submitted' || status === 'streaming';

  // 容器宽度（拖拽与 clamp 的基准）
  useEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 空状态（无消息）临时加宽对话以保留引导；用户拖过则以用户为准
  const effectiveRatio = userAdjusted ? ratio : messages.length === 0 ? 0.45 : 0.3;
  const chatWidth = useMemo(
    () => (containerW ? clampChatWidth(effectiveRatio * containerW, containerW) : 0),
    [effectiveRatio, containerW],
  );
  const leftWidth = containerW && chatWidth ? containerW - chatWidth : 0;

  function persistRatio(next: number) {
    setUserAdjusted(true);
    setRatio(next);
    window.localStorage.setItem(SPLIT_KEY, String(next));
  }

  function onDragStart(e: React.PointerEvent<HTMLDivElement>) {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onDragMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current || !splitRef.current) return;
    const rect = splitRef.current.getBoundingClientRect();
    const width = clampChatWidth(rect.right - e.clientX, rect.width);
    persistRatio(width / rect.width);
  }

  function onDragEnd(e: React.PointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function onDividerKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0;
    if (!step || !containerW) return;
    e.preventDefault();
    persistRatio(clampChatWidth(chatWidth + step, containerW) / containerW);
  }

  function resetDivider() {
    window.localStorage.removeItem(SPLIT_KEY);
    setUserAdjusted(false);
    setRatio(0);
  }

  // 生成过程中轮询构建产物版本，一旦变化就刷新预览（实时化）
  useEffect(() => {
    if (!id || !busy) return;
    let last = '';
    const t = setInterval(async () => {
      const r = await api.previewVersion(id).catch(() => null);
      if (r?.version) {
        setHasBuild(true);
        if (last && r.version !== last) setPreviewVersion((v) => v + 1);
        last = r.version;
      }
    }, 3000);
    return () => clearInterval(t);
  }, [id, busy]);

  async function publish() {
    if (!id || publishing) return;
    setPublishing(true);
    try {
      const r = await api.publish(id);
      setDeploy({ status: r.status, url: r.url, firstTime: r.firstTime });
      setPublishError('');
    } catch (err) {
      // 用站内提示替代 window.alert（阻塞式、且此前只展示原始信息）
      setPublishError(
        err instanceof Error ? err.message : '发布失败，请先让 Agent 构建成功',
      );
    } finally {
      setPublishing(false);
    }
  }

  async function unpublish() {
    if (!id) return;
    try {
      await api.unpublish(id);
      setDeploy({ status: 'stopped' });
      setPublishError('');
    } catch (err) {
      // 失败时保留原状态：谎报「已下架」会让用户以为链接已失效
      setPublishError(err instanceof Error ? err.message : '下架失败，请重试');
    }
  }

  // 发布启动中：轮询到 running
  useEffect(() => {
    if (!id || deploy?.status !== 'starting') return;
    const t = setInterval(async () => {
      const r = await api.deployment(id).catch(() => null);
      if (r) {
        setDeploy((d) => ({ status: r.status, url: r.url, firstTime: d?.firstTime }));
        if (r.status === 'error') {
          setPublishError((r as { message?: string }).message ?? '发布失败，请重新发布');
        }
      }
    }, 2500);
    return () => clearInterval(t);
  }, [id, deploy?.status]);

  // 载入历史消息 + 预览信息
  useEffect(() => {
    if (!id) return;
    api
      .messages(id)
      .then((r) =>
        setMessages(
          r.messages.map((m) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            parts: m.parts,
          })) as never,
        ),
      )
      .catch(() => {});
    api
      .previewUrl(id)
      .then((r) => setPreviewSrc(r.url))
      .catch(() => {});
    api
      .previewVersion(id)
      .then((r) => setHasBuild(Boolean(r.version)))
      // 探测失败就当没有产物：否则会一直停在「正在构建预览…」
      .catch(() => setHasBuild(false));
    api
      .getProject(id)
      .then((r) => setProjectTitle(r.project.title))
      .catch(() => {});
    // 已有数据库表的项目，进页面就应能看到「数据库」页签
    api
      .dbAvailability(id)
      .then((r) => setDbAvailable(r.dev.available || r.prod.available))
      .catch(() => {});
    api
      .deployment(id)
      .then((r) => {
        if (r.status && r.status !== 'none') setDeploy({ status: r.status, url: r.url });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 每轮结束后刷新文件树、当前文件与预览
  useEffect(() => {
    if (status === 'ready') {
      setFileVersion((v) => v + 1);
      window.dispatchEvent(new CustomEvent('atoms:credits'));
      setPreviewVersion((v) => v + 1);
      if (id) {
        api
          .previewVersion(id)
          .then((r) => setHasBuild(Boolean(r.version)))
          .catch(() => {});
        // 预览用独立子域；若有后端则启动开发应用（/api 才通）
        api
          .previewUrl(id)
          .then((r) => setPreviewSrc(r.url))
          .catch(() => {});
        api.startDevApp(id).catch(() => {});
        api
          .dbAvailability(id)
          .then((r) => setDbAvailable(r.dev.available || r.prod.available))
          .catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  // 余额：挂载取一次，生成结束后由 atoms:credits 事件刷新
  useEffect(() => {
    const load = () => {
      api
        .credits()
        .then((r) => setBalance(r.balance))
        .catch(() => {});
    };
    load();
    window.addEventListener('atoms:credits', load);
    return () => window.removeEventListener('atoms:credits', load);
  }, []);

  const previewHost = previewSrc
    ? (() => {
        try {
          return new URL(previewSrc).host;
        } catch {
          return previewSrc;
        }
      })()
    : '';

  const tabItems = useMemo(() => {
    const items: SegmentedItem<'preview' | 'files' | 'database'>[] = [
      { value: 'preview', label: '预览' },
      { value: 'files', label: '文件' },
    ];
    if (dbAvailable) items.push({ value: 'database', label: '数据库' });
    return items;
  }, [dbAvailable]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    sendMessage({ text });
    setInput('');
  }

  return (
    <div ref={splitRef} className="flex h-full">
      {/* 左：工作台（预览 / 文件 / 数据库） */}
      <div
        className={
          'border-border min-w-0 flex-col ' +
          (isWide
            ? leftWidth
              ? 'bg-surface flex border-r'
              : 'bg-surface flex flex-1 border-r'
            : showPanel
              ? 'bg-background fixed inset-0 z-30 flex'
              : 'hidden')
        }
        style={isWide && leftWidth ? { width: leftWidth } : undefined}
      >
        <div
          className="border-border flex h-12 shrink-0 items-center gap-3 border-b pr-3"
          style={{ paddingLeft: 'calc(0.75rem + var(--nav-overlay, 0px))' }}
        >
          <span className="max-w-52 truncate text-[13px] font-medium">
            {projectTitle || '项目'}
          </span>
          <Segmented value={tab} onChange={setTab} items={tabItems} />
          <div className="ml-auto flex items-center gap-1.5">
            <PopConfirm
              title="发布到线上？"
              description="将当前构建产物发布为独立应用，用户可通过链接访问。可随时下架。"
              confirmText="发布"
              onConfirm={publish}
            >
              <Button
                size="sm"
                variant="primary"
                className="h-8 px-3.5 text-[13.5px]"
                loading={publishing}
              >
                <IconRocket />
                {publishing ? '发布中' : '发布'}
              </Button>
            </PopConfirm>
          </div>
        </div>

        {deploy && deploy.status !== 'none' && (
          <div
            className={
              'border-border flex items-center gap-2 border-b px-3 py-1.5 text-[12px] ' +
              (deploy.status === 'running' ? 'bg-success/8' : 'bg-muted/50')
            }
          >
            {deploy.status === 'starting' && (
              <span className="text-muted-foreground">
                {deploy.firstTime ? '首次发布，正在安装依赖并启动…' : '正在启动应用…'}
              </span>
            )}
            {deploy.status === 'running' && deploy.url && (
              <>
                <span className="shrink-0" style={{ color: 'var(--success)' }}>
                  已发布
                </span>
                <a
                  href={deploy.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate underline"
                  style={{ color: 'var(--success)' }}
                >
                  {deploy.url}
                </a>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => navigator.clipboard?.writeText(deploy.url as string)}
                >
                  复制
                </Button>
                <PopConfirm
                  title="下架应用？"
                  description="线上链接将立即不可访问，随时可以重新发布。"
                  confirmText="下架"
                  danger
                  align="right"
                  onConfirm={unpublish}
                >
                  <Button size="sm" variant="ghost" className="text-danger ml-auto">
                    下架
                  </Button>
                </PopConfirm>
              </>
            )}
            {deploy.status === 'stopped' && (
              <span className="text-muted-foreground">
                已下架（点「发布」可重新上线）
              </span>
            )}
            {publishError && (
              <span className="text-danger min-w-0 flex-1 break-words">
                {publishError}
              </span>
            )}
            {!publishError && deploy.status === 'running' && !deploy.url && (
              <span className="text-muted-foreground min-w-0 flex-1">
                发布成功，但平台未配置应用域名（APPS_DOMAIN），暂时拿不到访问地址。
              </span>
            )}
            {deploy.status === 'error' && (
              <span className="text-danger">发布失败，请重试</span>
            )}
          </div>
        )}

        {tab === 'preview' ? (
          <div className="bg-muted/25 flex min-h-0 flex-1 flex-col p-3">
            <div className="border-border bg-surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
              <div className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-2.5">
                <span className="flex shrink-0 gap-1.5" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="bg-border-strong size-2 rounded-full" />
                  ))}
                </span>
                <div className="bg-muted mx-auto flex h-6 max-w-[360px] min-w-0 flex-1 items-center gap-1.5 rounded-xs px-2">
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="text-muted-foreground/70 shrink-0"
                  >
                    <rect x="4" y="10" width="16" height="10" rx="2" />
                    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                  </svg>
                  <span className="text-muted-foreground truncate font-mono text-[11px]">
                    {previewHost || '未就绪'}
                  </span>
                </div>
                <button
                  onClick={() => setPreviewVersion((v) => v + 1)}
                  aria-label="刷新预览"
                  className="text-muted-foreground hover:bg-muted hover:text-foreground grid size-6 shrink-0 place-items-center rounded-xs transition-colors"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  >
                    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
                    <path d="M20 5v6h-6" />
                  </svg>
                </button>
                <a
                  href={previewSrc || '#'}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="在新标签打开"
                  className={
                    'text-muted-foreground hover:bg-muted hover:text-foreground grid size-6 shrink-0 place-items-center rounded-xs transition-colors ' +
                    (previewSrc ? '' : 'pointer-events-none opacity-40')
                  }
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  >
                    <path d="M14 4h6v6" />
                    <path d="M20 4 11 13" />
                    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
                  </svg>
                </a>
              </div>
              {previewSrc && hasBuild ? (
                <iframe
                  key={previewVersion}
                  title="preview"
                  src={previewSrc + (previewVersion ? `?v=${previewVersion}` : '')}
                  className="min-h-0 w-full flex-1 bg-white"
                />
              ) : (
                <div className="blueprint grid min-h-0 flex-1 place-items-center px-6">
                  <div className="max-w-[34ch] text-center">
                    <span className="text-muted-foreground/45 inline-block">
                      <IconSparkle size={26} />
                    </span>
                    <p className="mt-3 text-[13px] font-medium">
                      {!previewSrc
                        ? '暂不可用'
                        : busy || hasBuild === null
                          ? '正在构建预览…'
                          : '还没有预览'}
                    </p>
                    <p className="text-muted-foreground mt-1.5 text-[12px] leading-relaxed">
                      {!previewSrc
                        ? '平台未配置应用域名（APPS_DOMAIN），暂时无法展示预览。'
                        : busy || hasBuild === null
                          ? 'Agent 构建完成后，应用会自动显示在这里。'
                          : '在右侧描述你想要的界面，Agent 会写好代码并构建，产物实时显示在这里。'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : tab === 'database' ? (
          <DatabaseView projectId={id as string} />
        ) : (
          <Suspense
            fallback={
              <p className="text-muted-foreground p-3 text-[12px]">加载编辑器…</p>
            }
          >
            <FileManager key={fileVersion} projectId={id as string} busy={busy} />
          </Suspense>
        )}
      </div>

      {/* 分隔条：拖动调整对话宽度（双击复位） */}
      {isWide && containerW > 0 && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整对话宽度"
          tabIndex={0}
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onDoubleClick={resetDivider}
          onKeyDown={onDividerKey}
          className="bg-border hover:bg-accent/60 focus-visible:bg-accent relative w-px shrink-0 cursor-col-resize transition-colors outline-none"
        >
          <span className="absolute inset-y-0 -right-1 -left-1" />
        </div>
      )}

      {/* 右：对话 */}
      <div
        className={
          'bg-background flex min-w-0 flex-col ' +
          (isWide ? '' : showPanel ? 'hidden' : 'flex flex-1')
        }
        style={isWide && chatWidth ? { width: chatWidth } : undefined}
      >
        <div className="border-border flex h-12 shrink-0 items-center gap-2.5 border-b px-3">
          <span className="truncate text-[13px] font-medium">Chat with me</span>
          {busy && (
            <span className="text-muted-foreground flex items-center gap-1.5 text-[11.5px]">
              <span
                className="size-1.5 animate-pulse rounded-full"
                style={{ background: 'var(--accent)' }}
                aria-hidden
              />
              生成中
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {busy && (
              <Button size="sm" variant="ghost" onClick={() => stop()}>
                停止
              </Button>
            )}
            <CreditsBadge />
            <Button
              size="sm"
              variant="outline"
              className="lg:hidden"
              onClick={() => setShowPanel((v) => !v)}
            >
              {showPanel ? '收起' : '预览'}
            </Button>
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {messages.length === 0 && (
            <div className="mx-auto max-w-[420px] pt-8">
              <span style={{ color: 'var(--accent)' }}>
                <AtomsMark size={24} />
              </span>
              <h2 className="mt-3.5 text-[15px] font-medium">描述你想创建的应用</h2>
              <p className="text-muted-foreground mt-1.5 text-[12.5px] leading-relaxed">
                Agent 会在真实沙箱里写代码、装依赖、构建，并把结果预览给你。
              </p>
              <div className="mt-5 grid grid-cols-2 gap-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => sendMessage({ text: `帮我${ex}` })}
                    className="panel hover:border-accent/45 hover:bg-muted/50 inline-flex items-center gap-2 px-3 py-2.5 text-left text-[12.5px] transition-colors"
                  >
                    <span className="text-accent-ink">
                      <IconSparkle size={13} />
                    </span>
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, idx) => {
            const animating =
              busy && idx === messages.length - 1 && m.role === 'assistant';
            if (m.role === 'user') {
              return (
                <div key={m.id} className="flex justify-end">
                  <div
                    className="bg-muted/60 max-w-[85%] rounded-sm border-l-2 px-3.5 py-2 text-[13px] whitespace-pre-wrap"
                    style={{ borderColor: 'var(--accent)' }}
                  >
                    {renderParts(m.parts as Part[], false)}
                  </div>
                </div>
              );
            }
            return (
              <div key={m.id} className="group/m max-w-[95%] text-[13.5px]">
                {renderParts(m.parts as Part[], animating)}
                <MessageFooter
                  parts={m.parts as Part[]}
                  canRegenerate={!busy && idx === messages.length - 1}
                  onRegenerate={() => regenerate()}
                />
              </div>
            );
          })}

          {error && (
            <div className="panel border-danger/35 bg-danger/6 flex items-center gap-3 px-3 py-2">
              <span className="text-danger text-[12.5px]">
                {friendlyError(error.message)}
              </span>
              {messages.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  onClick={() => regenerate()}
                >
                  重试
                </Button>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={submit} className="border-border border-t p-3.5">
          <div className="border-border bg-surface focus-within:border-ring rounded-md border p-2.5 transition-colors">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="描述你想创建的应用…"
              className="placeholder:text-muted-foreground/70 h-7 w-full bg-transparent px-0.5 text-[13px] outline-none"
            />
            <div className="mt-2 flex items-center gap-2">
              {balance !== null && (
                <span className="text-muted-foreground flex items-center gap-1.5 text-[11.5px]">
                  <span
                    className="size-1.5 rounded-full"
                    style={{ background: 'var(--accent)' }}
                    aria-hidden
                  />
                  积分剩余 <span className="tnum">{balance.toFixed(2)}</span>
                </span>
              )}
              <button
                type="submit"
                disabled={busy || !input.trim()}
                aria-label="发送"
                className="bg-accent text-accent-foreground ml-auto grid size-8 place-items-center rounded-full transition-opacity disabled:opacity-40"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
