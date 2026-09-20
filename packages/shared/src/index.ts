export type FileMap = Record<string, string>;

/** 文件树节点（平台 files 表的对外形态） */
export interface TreeNodeLike {
  id: string;
  pid: string | null;
  name: string;
  type: 'file' | 'dir';
  path: string;
}

export interface FlatRow<T> {
  node: T;
  depth: number;
}

/**
 * 把扁平节点列表按 pid 组装成「带层级的可见行」（目录优先、同类按名称排序）。
 * 仅展开 expanded 中的目录。纯函数，便于测试。
 */
export function flattenTree<T extends TreeNodeLike>(
  nodes: T[],
  expanded: ReadonlySet<string>,
): FlatRow<T>[] {
  const childrenOf = new Map<string | null, T[]>();
  for (const n of nodes) {
    const list = childrenOf.get(n.pid);
    if (list) list.push(n);
    else childrenOf.set(n.pid, [n]);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
  const out: FlatRow<T>[] = [];
  const walk = (pid: string | null, depth: number) => {
    for (const n of childrenOf.get(pid) ?? []) {
      out.push({ node: n, depth });
      if (n.type === 'dir' && expanded.has(n.id)) walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export interface Workspace {
  id: string;
  projectId: string;
}

export interface ExecChunk {
  stream: 'stdout' | 'stderr';
  data: string;
  /** 仅在命令结束的最后一个 chunk 上出现 */
  exitCode?: number;
}

/**
 * 运行时适配层：把“文件系统 + 执行”抽象出来。
 * Design 2 用 SandboxRuntime（B 机容器），本地可用 VirtualRuntime（内存）。
 */
export interface Runtime {
  open(projectId: string, files: FileMap, databaseUrl?: string): Promise<Workspace>;
  close(ws: Workspace): Promise<void>;

  readFile(ws: Workspace, path: string): Promise<string>;
  writeFile(ws: Workspace, path: string, content: string): Promise<void>;
  deleteFile(ws: Workspace, path: string): Promise<void>;
  editFile(ws: Workspace, path: string, oldStr: string, newStr: string): Promise<void>;
  listFiles(ws: Workspace): Promise<string[]>;

  exec(
    ws: Workspace,
    cmd: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<ExecChunk>;

  /** 源码快照，必须跳过 node_modules / dist / .cache / .git */
  snapshot(ws: Workspace): Promise<FileMap>;
  previewUrl(ws: Workspace): Promise<string>;
}

// ---- API DTOs ----
export interface UserDto {
  id: string;
  email: string;
  username: string;
}

export interface ProjectDto {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  error: string;
}
