export type FileMap = Record<string, string>;

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
  open(projectId: string, files: FileMap): Promise<Workspace>;
  close(ws: Workspace): Promise<void>;

  readFile(ws: Workspace, path: string): Promise<string>;
  writeFile(ws: Workspace, path: string, content: string): Promise<void>;
  editFile(ws: Workspace, path: string, oldStr: string, newStr: string): Promise<void>;
  listFiles(ws: Workspace): Promise<string[]>;

  exec(ws: Workspace, cmd: string): AsyncIterable<ExecChunk>;

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
