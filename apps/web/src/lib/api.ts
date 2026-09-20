import type { UserDto, ProjectDto } from '@atoms/shared';

/** 会话失效事件：由 App 统一处理（清用户态 + 提示重新登录） */
export const UNAUTHORIZED_EVENT = 'atoms:unauthorized';

/** 后端只回了错误码时，用它兜底成用户能看懂的中文 */
const FRIENDLY: Record<string, string> = {
  not_found: '内容不存在或无权访问',
  invalid_input: '输入不合法，请检查后重试',
  unauthorized: '登录已过期，请重新登录',
  id_required: '请求参数缺失，请刷新页面后重试',
  path_required: '缺少文件路径',
  table_not_found: '数据表不存在',
  busy: '正在生成中，请稍后再试',
  exists: '同名内容已存在',
  conflict: '内容已被更改，请重新加载后再试',
  release_limit: '已发布应用数量已达上限，请先下架其他应用',
  not_built: '还没有可用的构建产物，请先让 Agent 构建成功',
  build_failed: '构建未通过，请查看构建日志',
  sandbox_unreachable: '运行环境暂时不可用，请稍后重试',
  sandbox_error: '运行环境暂时不可用，请稍后重试',
  internal_error: '服务暂时不可用，请稍后重试',
  devapp_unreachable: '开发预览后端未运行，请点「重新构建」后再试',
  release_unreachable: '应用后端暂时无响应，请稍后重试',
  forbidden_origin: '请求来源校验失败，请刷新页面后重试',
  skill_limit: '技能数量已达上限，请先删除一些',
};

/** 登录/注册自身的 401 是「账号密码错」，不该触发全局登出 */
const AUTH_ENDPOINTS = ['/api/auth/login', '/api/auth/register'];

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
    const message =
      body.message ??
      (body.error ? (FRIENDLY[body.error] ?? body.error) : undefined) ??
      (res.status >= 500 ? '服务暂时不可用，请稍后重试' : `请求失败（${res.status}）`);
    const err = new Error(message) as Error & { code?: string; status?: number };
    err.code = body.error;
    err.status = res.status;
    // 会话过期：广播给 App 统一跳登录，避免各个页面各自处理（或静默失败）
    if (res.status === 401 && !AUTH_ENDPOINTS.some((p) => url.startsWith(p))) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
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

/** 用户自定义技能（知识型：正文作为参考资料注入，不作为系统指令） */
export interface SkillDto {
  id: string;
  name: string;
  description: string;
  body: string;
  /** 保存时扫出的「疑似密钥」类别；非空则前端显示警告标识 */
  secretFlags: string[];
  scope: 'user' | 'project';
  projectId: string | null;
  updatedAt: string;
}

export interface SkillInput {
  name: string;
  description: string;
  body: string;
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
  skills: (projectId?: string) =>
    req<{
      skills: SkillDto[];
      limit: number;
      limits: { name: number; description: number; body: number };
    }>(`/api/skills${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  createSkill: (d: SkillInput & { projectId?: string | null }) =>
    req<{ skill: SkillDto }>('/api/skills', {
      method: 'POST',
      body: JSON.stringify(d),
    }),
  updateSkill: (id: string, d: SkillInput) =>
    req<{ skill: SkillDto }>(`/api/skills/${id}`, {
      method: 'PUT',
      body: JSON.stringify(d),
    }),
  deleteSkill: (id: string) =>
    req<{ ok: boolean }>(`/api/skills/${id}`, { method: 'DELETE' }),
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
