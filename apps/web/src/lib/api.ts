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

export interface UsageWindow {
  status: string;
  percent: number;
  resetsAt: string;
}
export interface UsageResponse {
  usage?: {
    rolling?: UsageWindow;
    weekly?: UsageWindow;
    monthly?: UsageWindow;
  };
}

export interface TreeNode {
  id: string;
  pid: string | null;
  name: string;
  type: 'file' | 'dir';
  path: string;
  version: number;
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
  listProjects: () => req<{ projects: ProjectDto[] }>('/api/projects'),
  createProject: (title: string) =>
    req<{ project: ProjectDto }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  getProject: (id: string) => req<{ project: ProjectDto }>(`/api/projects/${id}`),
  renameProject: (id: string, title: string) =>
    req<{ project: ProjectDto }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
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
  usage: () => req<UsageResponse>('/api/usage'),
  previewVersion: (id: string) =>
    req<{ version: string }>(`/api/projects/${id}/preview-version`),
  previewUrl: (id: string) => req<{ url: string }>(`/api/projects/${id}/preview-url`),
  startDevApp: (id: string) =>
    req<{ hasBackend: boolean; ready: boolean }>(`/api/projects/${id}/devapp`, {
      method: 'POST',
    }),
  publish: (id: string) =>
    req<{ status: string; url: string }>(`/api/projects/${id}/publish`, {
      method: 'POST',
    }),
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
