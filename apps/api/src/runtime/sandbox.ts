import { createHash } from 'node:crypto';

import type { FileMap, Runtime, Workspace, ExecChunk } from '@atoms/shared';

import { applyEdit } from './edit';
import { SandboxError, signedFetch, signedJson } from './http';

/** 恢复工作区时的并发写上限：越大越快，但要给隧道/沙箱留余量 */
const WRITE_CONCURRENCY = 16;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 与沙箱侧 `wsDigest` 必须完全一致：路径排序后 `path\0hash` 以 \n 连接再取 sha256 */
function digestOf(hashes: Record<string, string>): string {
  const lines = Object.keys(hashes)
    .sort()
    .map((p) => `${p}\u0000${hashes[p]}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Design 2 实现：对接 B 机沙箱服务。
 * 每个项目一个沙箱（sandboxId = projectId）。
 */
export class SandboxRuntime implements Runtime {
  async open(
    projectId: string,
    files: FileMap,
    databaseUrl?: string,
  ): Promise<Workspace> {
    const id = projectId;
    await signedJson('/sandbox', {
      method: 'POST',
      body: JSON.stringify({ sandboxId: id, databaseUrl }),
    });
    const ws: Workspace = { id, projectId };
    // 只写入，不删除：DB 可能因上一轮生成中断而是过期/空的，
    // 若在此按 DB 清理沙箱，会把尚未落库的成果误删（真实事故）。
    // 删除由文件管理的显式操作（rename/delete）精确同步。
    //
    // 增量同步：A↔B 只有 ~1Mbps（实测 A→B 150KB/s），整仓重传要几分钟（3381 个文件
    // 曾把「打开项目自动拉起预览」拖到超时失败）。沙箱盘上的工作区是持久的，所以：
    //   1) 先比整仓摘要（64 字节）——一致就一个字节都不用传；
    //   2) 不一致再传清单（路径+哈希），由 B 回「需要写的文件」。
    const local: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) local[path] = sha256(content);
    let writePaths: string[] | null = null;
    const remoteDigest = await signedJson<{ digest: string }>(
      `/sandbox/${id}/ws-digest`,
      {
        method: 'GET',
      },
    )
      .then((r) => r.digest)
      .catch(() => null);
    if (remoteDigest === null) {
      writePaths = null; // 摘要都取不到：退回全量写，正确性优先
    } else if (remoteDigest === digestOf(local)) {
      writePaths = []; // 已在同步状态：无需上传
    } else {
      writePaths = await signedJson<{ write: string[] }>(`/sandbox/${id}/sync-plan`, {
        method: 'POST',
        body: JSON.stringify({ hashes: local }),
      })
        .then((r) => r.write)
        .catch(() => null);
    }
    const entries =
      writePaths === null
        ? Object.entries(files)
        : writePaths
            .map((p) => [p, files[p]] as const)
            .filter((e): e is readonly [string, string] => typeof e[1] === 'string');
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= entries.length) return;
        const entry = entries[i];
        if (!entry) continue;
        await this.writeFile(ws, entry[0], entry[1]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(WRITE_CONCURRENCY, entries.length) }, worker),
    );
    return ws;
  }

  async close(ws: Workspace): Promise<void> {
    await signedJson(`/sandbox/${ws.id}`, { method: 'DELETE' });
  }

  async readFile(ws: Workspace, path: string): Promise<string> {
    const r = await signedJson<{ content: string }>(
      `/sandbox/${ws.id}/file?path=${encodeURIComponent(path)}`,
      { method: 'GET' },
    );
    return r.content;
  }

  async writeFile(ws: Workspace, path: string, content: string): Promise<void> {
    await signedJson(`/sandbox/${ws.id}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    });
  }

  async deleteFile(ws: Workspace, path: string): Promise<void> {
    await signedJson(`/sandbox/${ws.id}/file?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
  }

  async editFile(
    ws: Workspace,
    path: string,
    oldStr: string,
    newStr: string,
  ): Promise<void> {
    const current = await this.readFile(ws, path);
    let next: string;
    try {
      next = applyEdit(current, oldStr, newStr);
    } catch (err) {
      throw new Error(`edit_file: ${(err as Error).message} in ${path}`);
    }
    await this.writeFile(ws, path, next);
  }

  async listFiles(ws: Workspace): Promise<string[]> {
    const r = await signedJson<{ files: string[] }>(`/sandbox/${ws.id}/files`, {
      method: 'GET',
    });
    return r.files;
  }

  async *exec(
    ws: Workspace,
    cmd: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<ExecChunk> {
    // 流式执行：长命令（pnpm install / build）可能跑几分钟，不能套用请求超时
    const res = await signedFetch(`/sandbox/${ws.id}/exec`, {
      method: 'POST',
      body: JSON.stringify({ cmd }),
      timeoutMs: 0,
      signal: opts?.signal,
    });
    if (!res.ok || !res.body) {
      throw new SandboxError(
        res.status < 500 ? res.status : 503,
        'exec_failed',
        '运行环境暂时不可用，请稍后重试',
      );
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const obj = JSON.parse(line) as {
          stream?: 'stdout' | 'stderr';
          data?: string;
          exitCode?: number;
        };
        if (obj.exitCode !== undefined) {
          yield { stream: 'stdout', data: '', exitCode: obj.exitCode };
          return;
        }
        if (obj.data) yield { stream: obj.stream ?? 'stdout', data: obj.data };
      }
    }
  }

  async snapshot(ws: Workspace): Promise<FileMap> {
    const r = await signedJson<{ files: FileMap }>(`/sandbox/${ws.id}/snapshot`, {
      method: 'POST',
      // 快照要逐文件读取，项目大时明显超过默认 30s（线上出现过 timeout 23）
      timeoutMs: 120_000,
    });
    return r.files;
  }

  async previewUrl(_ws: Workspace): Promise<string> {
    return '';
  }

  // ---- 已发布应用（常驻后端容器）----

  /** 启动/重启该应用的常驻后端容器（异步，容器内自行 install 后启动） */
  async startRelease(projectId: string, databaseUrl: string): Promise<void> {
    await signedJson(`/sandbox/${projectId}/release`, {
      method: 'POST',
      body: JSON.stringify({ databaseUrl }),
    });
  }

  async releaseStatus(
    projectId: string,
  ): Promise<{ running: boolean; ip: string; ready: boolean }> {
    return signedJson(`/sandbox/${projectId}/release/status`, { method: 'GET' });
  }

  async stopRelease(projectId: string): Promise<void> {
    await signedJson(`/sandbox/${projectId}/release/stop`, { method: 'POST' });
  }

  // ---- 开发预览应用（dev-<id> 子域）----

  async startDevApp(projectId: string, databaseUrl: string): Promise<void> {
    await signedJson(`/sandbox/${projectId}/devapp`, {
      method: 'POST',
      body: JSON.stringify({ databaseUrl }),
    });
  }

  async devAppStatus(
    projectId: string,
  ): Promise<{ running: boolean; ip: string; ready: boolean }> {
    return signedJson(`/sandbox/${projectId}/devapp/status`, { method: 'GET' });
  }

  /** 强制重启开发预览后端（加载最新源码） */
  async restartDevApp(projectId: string, databaseUrl: string): Promise<void> {
    await signedJson(`/sandbox/${projectId}/devapp/restart`, {
      method: 'POST',
      body: JSON.stringify({ databaseUrl }),
    });
  }
}
