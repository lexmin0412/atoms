import type { FileMap, Runtime, Workspace, ExecChunk } from '@atoms/shared';

import { applyEdit } from './edit';
import { signedFetch, signedJson } from './http';

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
    for (const [path, content] of Object.entries(files)) {
      await this.writeFile(ws, path, content);
    }
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

  async *exec(ws: Workspace, cmd: string): AsyncIterable<ExecChunk> {
    const res = await signedFetch(`/sandbox/${ws.id}/exec`, {
      method: 'POST',
      body: JSON.stringify({ cmd }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`exec failed: ${res.status}`);
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
}
