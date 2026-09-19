import type { UserDto, ProjectDto } from '@atoms/shared';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
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
  tree: (id: string) => req<{ files: string[] }>(`/api/projects/${id}/tree`),
  file: (id: string, path: string) =>
    req<{ path: string; content: string }>(
      `/api/projects/${id}/file?path=${encodeURIComponent(path)}`,
    ),
  usage: () => req<UsageResponse>('/api/usage'),
  previewVersion: (id: string) =>
    req<{ version: string }>(`/api/projects/${id}/preview-version`),
  publish: (id: string) =>
    req<{ url: string; token: string }>(`/api/projects/${id}/publish`, {
      method: 'POST',
    }),
};
