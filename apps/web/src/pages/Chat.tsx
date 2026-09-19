import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import Reasoning from '../components/Reasoning';
import { api } from '../lib/api';

// 懒加载：Streamdown + Shiki 体积较大，推迟到首条消息渲染时再加载
const Markdown = lazy(() => import('../components/Markdown'));

const EXAMPLES = ['做一个番茄钟', '一个待办清单', '一个极简记账本', '一个数据看板'];

function friendlyError(msg: string): string {
  if (/busy|429|当前运行中的应用较多|额度|上限/.test(msg)) {
    return '当前使用人数较多或已达额度上限，请稍后再试。';
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

  return (
    <div className="my-2 rounded-lg border border-neutral-200 bg-neutral-50 text-sm dark:border-neutral-800 dark:bg-neutral-900">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-neutral-400">{open ? '▾' : '▸'}</span>
        <span className="font-medium">{toolLabel(name)}</span>
        <span className="truncate text-neutral-500">{summarize(name, part.input)}</span>
        <span
          className={
            'ml-auto shrink-0 text-xs ' +
            (running ? 'text-amber-500' : failed ? 'text-red-500' : 'text-green-600')
          }
        >
          {running ? '运行中…' : failed ? '失败' : '完成'}
        </span>
      </button>
      {open && outputText && (
        <pre className="max-h-72 overflow-auto border-t border-neutral-200 px-3 py-2 text-xs whitespace-pre-wrap dark:border-neutral-800">
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

function TerminalBlock({ cmd, text }: { cmd: string; text: string }) {
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 text-xs">
      <div className="border-b border-neutral-800 px-3 py-1.5 font-mono text-neutral-400">
        $ {cmd}
      </div>
      <pre className="max-h-72 overflow-auto px-3 py-2 font-mono whitespace-pre-wrap text-neutral-200">
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
  const [files, setFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [tab, setTab] = useState<'preview' | 'files'>('preview');
  const [previewVersion, setPreviewVersion] = useState(0);
  const [showPanel, setShowPanel] = useState(false);
  const [deploy, setDeploy] = useState<{ status: string; url?: string } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: `/api/projects/${id}/chat` }),
    [id],
  );
  const { messages, sendMessage, status, error, setMessages, stop, regenerate } = useChat(
    { transport },
  );

  const busy = status === 'submitted' || status === 'streaming';

  // 生成过程中轮询构建产物版本，一旦变化就刷新预览（实时化）
  useEffect(() => {
    if (!id || !busy) return;
    let last = '';
    const t = setInterval(async () => {
      const r = await api.previewVersion(id).catch(() => null);
      if (r?.version) {
        if (last && r.version !== last) setPreviewVersion((v) => v + 1);
        last = r.version;
      }
    }, 3000);
    return () => clearInterval(t);
  }, [id, busy]);

  async function refreshTree() {
    if (!id) return;
    const r = await api.tree(id).catch(() => ({ files: [] as string[] }));
    setFiles(r.files);
    if (!activeFile && r.files.length) {
      openFile(r.files[0]);
    }
  }

  async function openFile(path: string) {
    if (!id) return;
    setActiveFile(path);
    const r = await api.file(id, path).catch(() => ({ path, content: '' }));
    setFileContent(r.content);
  }

  async function publish() {
    if (!id || publishing) return;
    setPublishing(true);
    try {
      const r = await api.publish(id);
      setDeploy({ status: r.status, url: r.url });
    } catch (err) {
      window.alert(
        '发布失败：' + (err instanceof Error ? err.message : '请先让 Agent 成功构建'),
      );
    } finally {
      setPublishing(false);
    }
  }

  async function unpublish() {
    if (!id) return;
    await api.unpublish(id).catch(() => {});
    setDeploy({ status: 'stopped' });
  }

  // 发布启动中：轮询到 running
  useEffect(() => {
    if (!id || deploy?.status !== 'starting') return;
    const t = setInterval(async () => {
      const r = await api.deployment(id).catch(() => null);
      if (r) setDeploy({ status: r.status, url: r.url });
    }, 2500);
    return () => clearInterval(t);
  }, [id, deploy?.status]);

  // 载入历史消息 + 文件树
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
    refreshTree();
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
      refreshTree();
      if (activeFile) openFile(activeFile);
      setPreviewVersion((v) => v + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    sendMessage({ text });
    setInput('');
  }

  return (
    <div className="flex h-full">
      {/* 左：对话 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
          <Link
            to="/"
            className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
          >
            ← 返回
          </Link>
          <h1 className="text-sm font-medium">对话</h1>
          <button
            onClick={() => setShowPanel((v) => !v)}
            className="ml-auto rounded border border-neutral-300 px-2 py-1 text-xs md:hidden dark:border-neutral-700"
          >
            {showPanel ? '收起' : '预览/文件'}
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="text-sm text-neutral-500">
              <p className="mb-3">描述你想创建的应用，或从下面选一个开始：</p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => sendMessage({ text: `帮我${ex}` })}
                    className="rounded-full border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, idx) => {
            const animating =
              busy && idx === messages.length - 1 && m.role === 'assistant';
            return (
              <div
                key={m.id}
                className={
                  m.role === 'user'
                    ? 'ml-auto max-w-[85%] rounded-2xl bg-neutral-900 px-4 py-2 text-sm whitespace-pre-wrap text-white dark:bg-white dark:text-neutral-900'
                    : 'max-w-[92%] text-sm'
                }
              >
                {renderParts(m.parts as Part[], animating)}
              </div>
            );
          })}
          {busy && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400">生成中…</span>
              <button
                onClick={() => stop()}
                className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                停止
              </button>
            </div>
          )}
          {error && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-red-500">{friendlyError(error.message)}</span>
              {messages.length > 0 && (
                <button
                  onClick={() => regenerate()}
                  className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950"
                >
                  重试
                </button>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <form
          onSubmit={submit}
          className="flex gap-2 border-t border-neutral-200 px-4 py-3 dark:border-neutral-800"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="说点什么…"
            className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
          <button
            disabled={busy || !input.trim()}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            发送
          </button>
        </form>
      </div>

      {/* 右：预览 / 文件 */}
      <div
        className={
          'shrink-0 flex-col border-neutral-200 dark:border-neutral-800 ' +
          (showPanel
            ? 'fixed inset-0 z-30 flex w-full bg-white md:static md:z-auto md:w-[440px] md:border-l dark:bg-neutral-950'
            : 'hidden md:flex md:w-[440px] md:border-l')
        }
      >
        <div className="flex items-center gap-1 border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
          <button
            onClick={() => setTab('preview')}
            className={
              'rounded px-2 py-1 text-sm ' +
              (tab === 'preview'
                ? 'bg-neutral-100 font-medium dark:bg-neutral-800'
                : 'text-neutral-500')
            }
          >
            预览
          </button>
          <button
            onClick={() => setTab('files')}
            className={
              'rounded px-2 py-1 text-sm ' +
              (tab === 'files'
                ? 'bg-neutral-100 font-medium dark:bg-neutral-800'
                : 'text-neutral-500')
            }
          >
            文件
          </button>
          <div className="ml-auto flex items-center gap-1">
            {tab === 'preview' && (
              <button
                onClick={() => setPreviewVersion((v) => v + 1)}
                className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                刷新
              </button>
            )}
            <button
              onClick={publish}
              disabled={publishing}
              className="rounded bg-neutral-900 px-2 py-1 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {publishing ? '发布中…' : '发布'}
            </button>
          </div>
        </div>

        {deploy && deploy.status !== 'none' && (
          <div
            className={
              'flex items-center gap-2 border-b border-neutral-200 px-3 py-1.5 text-xs dark:border-neutral-800 ' +
              (deploy.status === 'running'
                ? 'bg-emerald-50 dark:bg-emerald-950'
                : 'bg-neutral-50 dark:bg-neutral-900')
            }
          >
            {deploy.status === 'starting' && (
              <span className="text-neutral-500">发布启动中…（首次安装依赖，稍候）</span>
            )}
            {deploy.status === 'running' && deploy.url && (
              <>
                <span className="shrink-0 text-emerald-700 dark:text-emerald-300">
                  已发布：
                </span>
                <a
                  href={deploy.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-emerald-700 underline dark:text-emerald-300"
                >
                  {deploy.url}
                </a>
                <button
                  onClick={() => navigator.clipboard?.writeText(deploy.url as string)}
                  className="shrink-0 rounded px-2 py-0.5 text-emerald-700 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-900"
                >
                  复制
                </button>
                <button
                  onClick={unpublish}
                  className="ml-auto shrink-0 rounded px-2 py-0.5 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                >
                  下架
                </button>
              </>
            )}
            {deploy.status === 'stopped' && (
              <span className="text-neutral-500">已下架（点「发布」可重新上线）</span>
            )}
            {deploy.status === 'error' && (
              <span className="text-red-500">发布失败，请重试</span>
            )}
          </div>
        )}

        {tab === 'preview' ? (
          <iframe
            key={previewVersion}
            title="preview"
            src={`/api/projects/${id}/preview/`}
            className="min-h-0 w-full flex-1 bg-white"
          />
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="w-44 shrink-0 overflow-y-auto border-r border-neutral-200 py-2 text-xs dark:border-neutral-800">
              {files.length === 0 && <p className="px-3 text-neutral-400">暂无文件</p>}
              {files.map((f) => (
                <button
                  key={f}
                  onClick={() => openFile(f)}
                  className={
                    'block w-full truncate px-3 py-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800 ' +
                    (activeFile === f
                      ? 'bg-neutral-100 font-medium dark:bg-neutral-800'
                      : '')
                  }
                  title={f}
                >
                  {f}
                </button>
              ))}
            </div>
            <div className="min-w-0 flex-1 overflow-auto">
              {activeFile ? (
                <>
                  <div className="sticky top-0 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
                    {activeFile}
                  </div>
                  <pre className="p-3 text-xs leading-relaxed whitespace-pre-wrap">
                    {fileContent}
                  </pre>
                </>
              ) : (
                <p className="p-3 text-xs text-neutral-400">选择文件查看源码</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
