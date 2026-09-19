import type { ProjectDto, UserDto } from '@atoms/shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import CreditsBadge from '../components/CreditsBadge';
import { api } from '../lib/api';

export default function Projects({
  user,
  onLogout,
}: {
  user: UserDto;
  onLogout: () => void;
}) {
  const nav = useNavigate();
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const r = await api.listProjects();
      setProjects(r.projects);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    api
      .listProjects()
      .then((r) => {
        if (alive) setProjects(r.projects);
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
    if (!title.trim()) return;
    setBusy(true);
    try {
      const r = await api.createProject(title.trim());
      setTitle('');
      nav(`/p/${r.project.id}`);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api.logout().catch(() => {});
    onLogout();
  }

  async function rename(p: ProjectDto) {
    const t = window.prompt('重命名项目', p.title);
    if (!t || t.trim() === p.title) return;
    await api.renameProject(p.id, t.trim()).catch(() => {});
    refresh();
  }

  async function remove(p: ProjectDto) {
    if (!window.confirm(`删除项目「${p.title}」？此操作不可恢复。`)) return;
    await api.deleteProject(p.id).catch(() => {});
    refresh();
  }

  return (
    <div className="mx-auto min-h-full max-w-3xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Atoms</h1>
          <p className="text-sm text-neutral-500">{user.username}</p>
        </div>
        <div className="flex items-center gap-4">
          <CreditsBadge />
          <button
            onClick={logout}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            退出
          </button>
        </div>
      </header>

      <form onSubmit={create} className="mb-6 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="新建项目，例如：一个待办清单"
          className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <button
          disabled={busy || !title.trim()}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          创建
        </button>
      </form>

      {loading ? (
        <p className="text-sm text-neutral-500">加载中…</p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-neutral-500">还没有项目，创建一个开始吧。</p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {projects.map((p) => (
            <li key={p.id} className="group flex items-center">
              <button
                onClick={() => nav(`/p/${p.id}`)}
                className="flex flex-1 items-center justify-between px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                <span className="text-sm font-medium">{p.title}</span>
                <span className="text-xs text-neutral-400">{p.status}</span>
              </button>
              <div className="flex items-center gap-1 pr-3 opacity-0 transition group-hover:opacity-100">
                <button
                  onClick={() => rename(p)}
                  className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  重命名
                </button>
                <button
                  onClick={() => remove(p)}
                  className="rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
