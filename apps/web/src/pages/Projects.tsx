import type { ProjectDto } from '@atoms/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '../components/ui/Button';
import { ConfirmDialog, PromptDialog } from '../components/ui/confirm';
import { Field } from '../components/ui/Field';
import { IconPlus } from '../components/ui/icons';
import { AtomsMark } from '../components/ui/Logo';
import { api } from '../lib/api';
import { cx } from '../lib/cx';

/** 由项目 id 派生一个稳定的色相（限制在暖中性区间，避免花） */
function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360;
  return 20 + (h % 60); // 20–80：暖橙 → 琥珀 → 黄绿
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

/** 项目缩略图：优先用应用自己的图标（Agent 生成的 icon.svg），否则用确定性占位 */
function Thumb({ id, className }: { id: string; className?: string }) {
  const hue = hueOf(id);
  const [hasIcon, setHasIcon] = useState(true);
  return (
    <div className={cx('relative aspect-[16/10] overflow-hidden bg-surface', className)}>
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(120% 90% at 25% 0%, oklch(0.88 0.05 ${hue} / 13%), transparent 62%), linear-gradient(var(--grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--grid-line) 1px, transparent 1px)`,
          backgroundSize: '100% 100%, 20px 20px, 20px 20px',
        }}
        aria-hidden
      />
      <div className="absolute inset-0 grid place-items-center">
        {hasIcon ? (
          <img
            src={`/api/projects/${id}/icon`}
            alt=""
            loading="lazy"
            onError={() => setHasIcon(false)}
            className="size-11 rounded-sm object-contain drop-shadow-[0_1px_2px_oklch(0_0_0/12%)]"
          />
        ) : (
          <span className="text-muted-foreground/35">
            <AtomsMark size={34} />
          </span>
        )}
      </div>
    </div>
  );
}

function CardMenu({
  onOpen,
  onRename,
  onDelete,
}: {
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div className="relative" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="更多操作"
        className="text-muted-foreground hover:bg-muted hover:text-foreground grid size-7 place-items-center rounded-xs transition-colors"
      >
        ⋯
      </button>
      {open && (
        <div className="panel-raised absolute right-0 z-30 mt-1 w-32 py-1">
          {[
            { label: '打开', fn: onOpen },
            { label: '重命名', fn: onRename },
            { label: '删除', fn: onDelete, danger: true },
          ].map((it) => (
            <button
              key={it.label}
              onClick={() => {
                setOpen(false);
                it.fn();
              }}
              className={cx(
                'block w-full px-3 py-1.5 text-left text-[12.5px] transition-colors',
                it.danger ? 'text-danger hover:bg-danger/10' : 'hover:bg-muted',
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Projects() {
  const nav = useNavigate();
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<ProjectDto | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<ProjectDto | null>(null);
  const [error, setError] = useState('');

  /** 列表加载失败：不能清空已有列表，否则用户以为项目全被删了 */
  async function refresh() {
    try {
      const r = await api.listProjects();
      setProjects(r.projects);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '项目列表加载失败');
    }
  }

  useEffect(() => {
    let alive = true;
    api
      .listProjects()
      .then((r) => {
        if (!alive) return;
        setProjects(r.projects);
        setError('');
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : '项目列表加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.createProject(title.trim());
      setTitle('');
      setCreating(false);
      nav(`/p/${r.project.id}`);
    } catch (err) {
      // 以前漏了 catch：创建失败时弹窗不关、也没有任何反馈
      setError(err instanceof Error ? err.message : '创建失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  async function rename(p: ProjectDto) {
    const name = renameValue.trim();
    if (name) {
      try {
        await api.renameProject(p.id, name);
      } catch (err) {
        setError(err instanceof Error ? err.message : '重命名失败');
      }
    }
    setRenaming(null);
    refresh();
  }

  async function remove(p: ProjectDto) {
    try {
      await api.deleteProject(p.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    }
    setDeleting(null);
    refresh();
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-9">
      <div className="mb-7 flex items-center justify-between gap-4">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">我的项目</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <IconPlus />
          新建项目
        </Button>
      </div>

      {/* 已有列表时的操作失败（重命名/删除等）：顶部提示，不清空列表 */}
      {error && projects.length > 0 && (
        <div className="border-danger/30 bg-danger/8 text-danger mb-4 flex items-start gap-2 rounded-sm border px-3 py-2 text-[12.5px]">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            className="shrink-0 underline opacity-80 hover:opacity-100"
            onClick={() => setError('')}
          >
            关闭
          </button>
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="panel overflow-hidden">
              <div className="bg-muted aspect-[16/10] animate-pulse" />
              <div className="space-y-2 p-3">
                <div className="bg-muted h-3 w-2/3 animate-pulse rounded-xs" />
                <div className="bg-muted h-2.5 w-1/3 animate-pulse rounded-xs" />
              </div>
            </div>
          ))}
        </div>
      ) : error && projects.length === 0 ? (
        <div className="panel flex flex-col items-center px-6 py-20 text-center">
          <p className="text-[13.5px] font-medium">项目列表加载失败</p>
          <p className="text-muted-foreground mt-1.5 max-w-sm text-[12.5px] break-words">
            {error}
          </p>
          <Button
            className="mt-5"
            onClick={() => {
              setLoading(true);
              void api
                .listProjects()
                .then((r) => {
                  setProjects(r.projects);
                  setError('');
                })
                .catch((err: unknown) =>
                  setError(err instanceof Error ? err.message : '项目列表加载失败'),
                )
                .finally(() => setLoading(false));
            }}
          >
            重试
          </Button>
        </div>
      ) : projects.length === 0 ? (
        <div className="panel flex flex-col items-center px-6 py-20 text-center">
          <span style={{ color: 'var(--accent-ink)' }}>
            <AtomsMark size={32} />
          </span>
          <p className="mt-4 text-[14px] font-medium">还没有项目</p>
          <p className="text-muted-foreground mt-1.5 max-w-[36ch] text-[12.5px] leading-relaxed">
            描述你想做的东西，比如「一个番茄钟」或「一个数据看板」，Agent
            会在真实沙箱里把它做出来。
          </p>
          <Button variant="primary" className="mt-5" onClick={() => setCreating(true)}>
            <IconPlus />
            新建项目
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {projects.map((p) => (
            <div
              key={p.id}
              onClick={() => nav(`/p/${p.id}`)}
              className="panel group hover:border-border-strong cursor-pointer overflow-hidden transition-colors"
            >
              <Thumb id={p.id} className="border-border rounded-none border-0 border-b" />
              <div className="flex items-center gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{p.title}</p>
                  <p className="tnum text-muted-foreground mt-0.5 text-[11.5px]">
                    {fmtDate(p.updatedAt)}
                  </p>
                </div>
                <div className="opacity-0 transition-opacity group-hover:opacity-100">
                  <CardMenu
                    onOpen={() => nav(`/p/${p.id}`)}
                    onRename={() => {
                      setRenameValue(p.title);
                      setRenaming(p);
                    }}
                    onDelete={() => setDeleting(p)}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <PromptDialog
        open={!!renaming}
        title="重命名项目"
        value={renameValue}
        onChange={setRenameValue}
        placeholder="项目名称"
        onConfirm={() => {
          if (renaming) return rename(renaming);
        }}
        onCancel={() => setRenaming(null)}
      />

      <ConfirmDialog
        open={!!deleting}
        title={`删除项目「${deleting?.title ?? ''}」？`}
        description="项目源码、数据库表与已发布的应用都会被移除，此操作不可恢复。"
        confirmText="删除"
        danger
        onConfirm={() => {
          if (deleting) return remove(deleting);
        }}
        onCancel={() => setDeleting(null)}
      />

      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-[1px]">
          <form onSubmit={create} className="panel-raised w-96 p-5">
            <p className="mb-1 text-[14px] font-medium">新建项目</p>
            <p className="text-muted-foreground mb-4 text-[12px]">
              一句话描述你想做的东西，细节可以之后再聊。
            </p>
            <Field
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
              placeholder="例如：一个带统计的番茄钟"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setCreating(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                size="sm"
                variant="primary"
                loading={busy}
                disabled={!title.trim()}
              >
                创建
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
