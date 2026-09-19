import type { UserDto, ProjectDto } from '@atoms/shared';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    const err = new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
    (err as Error & { code?: string }).code = body.error;
    throw err;
  }
  return (await res.json()) as T;
}

export interface TreeNode {
  id: string;
  pid: string | null;
  name: string;
  type: 'file' | 'dir';
  path: string;
  version: number;
}

export interface CreditSummary {
  balance: number;
  spent: number;
  monthlyGrant: number;
  period: string;
}

export interface LedgerEntry {
  id: string;
  delta: string;
  balance_after: string;
  reason: 'grant' | 'usage' | 'adjust';
  project_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

type RawProject = {
  id: string;
  title: string;
  status: string;
  created_at?: string;
  updated_at?: string;
  createdAt?: string;
  updatedAt?: string;
};

/** 接口返回 snake_case，这里统一成 DTO 的 camelCase */
function normalizeProject(p: RawProject): ProjectDto {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    createdAt: p.createdAt ?? p.created_at ?? '',
    updatedAt: p.updatedAt ?? p.updated_at ?? '',
  };
}

export const api = {
  me: () => req<{ user: UserDto }>('/api/auth/me'),
  register: (d: { email: string; username: string; password: string }) =>
    req<{ user: UserDto }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(d),
    }),
  login: (d: { email: string; password: string }) =>
    req<{ user: UserDto }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(d),
    }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  listProjects: () =>
    req<{ projects: RawProject[] }>('/api/projects').then((r) => ({
      projects: r.projects.map(normalizeProject),
    })),
  createProject: (title: string) =>
    req<{ project: RawProject }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }).then((r) => ({ project: normalizeProject(r.project) })),
  getProject: (id: string) =>
    req<{ project: RawProject }>(`/api/projects/${id}`).then((r) => ({
      project: normalizeProject(r.project),
    })),
  renameProject: (id: string, title: string) =>
    req<{ project: RawProject }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }).then((r) => ({ project: normalizeProject(r.project) })),
  deleteProject: (id: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  messages: (id: string) =>
    req<{ messages: { id: string; seq: number; role: string; parts: unknown[] }[] }>(
      `/api/projects/${id}/messages`,
    ),
  tree: (id: string) =>
    req<{ nodes: TreeNode[]; busy: boolean }>(`/api/projects/${id}/tree`),
  file: (id: string, path: string) =>
    req<{ path: string; content: string; version: number }>(
      `/api/projects/${id}/file?path=${encodeURIComponent(path)}`,
    ),
  createFile: (
    id: string,
    d: { parentId: string | null; name: string; content?: string },
  ) =>
    req<{ node: TreeNode }>(`/api/projects/${id}/fs/file`, {
      method: 'POST',
      body: JSON.stringify(d),
    }),
  createDir: (id: string, d: { parentId: string | null; name: string }) =>
    req<{ node: TreeNode }>(`/api/projects/${id}/fs/dir`, {
      method: 'POST',
      body: JSON.stringify(d),
    }),
  saveFile: (id: string, nodeId: string, content: string, version: number) =>
    req<{ version: number }>(`/api/projects/${id}/fs/file/${nodeId}`, {
      method: 'PUT',
      body: JSON.stringify({ content, version }),
    }),
  renameNode: (id: string, nodeId: string, name: string, parentId?: string | null) =>
    req<{ path: string }>(`/api/projects/${id}/fs/node/${nodeId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ name, parentId }),
    }),
  deleteNode: (id: string, nodeId: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}/fs/node/${nodeId}`, { method: 'DELETE' }),
  rebuild: (id: string) =>
    req<{ ok: boolean; log?: string }>(`/api/projects/${id}/rebuild`, { method: 'POST' }),
  credits: () => req<CreditSummary>('/api/credits'),
  creditsLedger: (page: number, projectId?: string) =>
    req<{ rows: LedgerEntry[]; total: number; page: number; pageSize: number }>(
      `/api/credits/ledger?page=${page}${projectId ? `&projectId=${projectId}` : ''}`,
    ),
  previewVersion: (id: string) =>
    req<{ version: string }>(`/api/projects/${id}/preview-version`),
  previewUrl: (id: string) => req<{ url: string }>(`/api/projects/${id}/preview-url`),
  startDevApp: (id: string) =>
    req<{ hasBackend: boolean; ready: boolean }>(`/api/projects/${id}/devapp`, {
      method: 'POST',
    }),
  publish: (id: string) =>
    req<{ status: string; url: string; firstTime?: boolean }>(
      `/api/projects/${id}/publish`,
      { method: 'POST' },
    ),
  deployment: (id: string) =>
    req<{ status: string; url?: string }>(`/api/projects/${id}/deployment`),
  unpublish: (id: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}/unpublish`, { method: 'POST' }),
  dbAvailability: (id: string) =>
    req<{
      dev: { available: boolean; tables: number };
      prod: { available: boolean; tables: number };
    }>(`/api/projects/${id}/db/availability`),
  dbTables: (id: string, env: 'dev' | 'prod') =>
    req<{ env: string; tables: { name: string; rows: number | null }[] }>(
      `/api/projects/${id}/db/tables?env=${env}`,
    ),
  dbColumns: (id: string, env: 'dev' | 'prod', table: string) =>
    req<{ table: string; columns: { name: string; type: string; nullable: boolean }[] }>(
      `/api/projects/${id}/db/tables/${encodeURIComponent(table)}?env=${env}`,
    ),
  dbRows: (id: string, env: 'dev' | 'prod', table: string, page: number) =>
    req<{
      rows: Record<string, unknown>[];
      total: number;
      page: number;
      pageSize: number;
    }>(
      `/api/projects/${id}/db/tables/${encodeURIComponent(table)}/rows?env=${env}&page=${page}`,
    ),
};
