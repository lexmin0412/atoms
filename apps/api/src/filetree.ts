import type { FileMap } from '@atoms/shared';
import type { PoolClient, QueryResult } from 'pg';

import { pool, query } from './db';

export interface TreeNode {
  id: string;
  pid: string | null;
  name: string;
  type: 'file' | 'dir';
  path: string;
  version: number;
}

/** 读取项目所有节点（树，按 path 排序） */
export async function listTree(projectId: string): Promise<TreeNode[]> {
  const r = await query<TreeNode>(
    `select id, pid, name, type, path, version
       from files where project_id = $1 order by type, path`,
    [projectId],
  );
  return r.rows;
}

/** 读取项目的「路径 → 内容」映射（供 Agent / 沙箱同步，只取文件） */
export async function loadFileMap(projectId: string): Promise<FileMap> {
  const r = await query<{ path: string; content: string | null }>(
    `select path, content from files where project_id = $1 and type = 'file'`,
    [projectId],
  );
  const map: FileMap = {};
  for (const row of r.rows) map[row.path] = row.content ?? '';
  return map;
}

export async function readFile(
  projectId: string,
  path: string,
): Promise<{ content: string; version: number }> {
  const r = await query<{ content: string | null; version: number }>(
    `select content, version from files where project_id = $1 and path = $2 and type = 'file'`,
    [projectId, path],
  );
  if (!r.rowCount) throw new Error('not_found');
  return { content: r.rows[0].content ?? '', version: r.rows[0].version };
}

type Client = PoolClient;

/** 逐级确保目录存在，返回叶子目录 id（dirPath 为空时返回 null） */
async function ensureDirPath(
  client: Client,
  projectId: string,
  dirPath: string,
): Promise<string | null> {
  const segs = dirPath.split('/').filter(Boolean);
  let parent: string | null = null;
  let acc = '';
  for (const seg of segs) {
    acc = acc ? `${acc}/${seg}` : seg;
    const r = await client.query<{ id: string }>(
      'select id from files where project_id = $1 and path = $2',
      [projectId, acc],
    );
    if (r.rowCount) {
      parent = r.rows[0].id;
      continue;
    }
    const ins: QueryResult<{ id: string }> = await client.query<{ id: string }>(
      `insert into files (project_id, pid, name, type, path, content)
       values ($1, $2, $3, 'dir', $4, null) returning id`,
      [projectId, parent, seg, acc],
    );
    parent = ins.rows[0].id;
  }
  return parent;
}

/** 逐级确保目录存在，返回父目录 id（用于文件落位） */
async function ensureDirChain(
  client: Client,
  projectId: string,
  filePath: string,
): Promise<string | null> {
  const segs = filePath.split('/');
  segs.pop(); // 去掉文件名
  return ensureDirPath(client, projectId, segs.join('/'));
}

/** 规范化用户输入的名称：允许 a/b/c 形式（自动建中间目录） */
function normalizeName(raw: string): string {
  return raw
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
}

/** Agent 快照写回：以 FileMap 为准，重建/更新树（保留已有节点 id） */
export async function saveFileMap(projectId: string, map: FileMap) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const existing = await client.query<{ id: string; path: string; type: string }>(
      'select id, path, type from files where project_id = $1',
      [projectId],
    );
    const keep = new Set(Object.keys(map));
    for (const row of existing.rows) {
      if (row.type === 'file' && !keep.has(row.path)) {
        await client.query('delete from files where id = $1', [row.id]);
      }
    }
    for (const [path, content] of Object.entries(map)) {
      const parent = await ensureDirChain(client, projectId, path);
      const name = path.split('/').pop() as string;
      await client.query(
        `insert into files (project_id, pid, name, type, path, content)
         values ($1, $2, $3, 'file', $4, $5)
         on conflict (project_id, path) do update set
           content = excluded.content,
           version = files.version + case
             when files.content is distinct from excluded.content then 1 else 0 end,
           updated_at = now()`,
        [projectId, parent, name, path, content],
      );
    }
    // 清理空目录
    await client.query(
      `delete from files f
        where f.project_id = $1 and f.type = 'dir'
          and not exists (select 1 from files c where c.pid = f.id)`,
      [projectId],
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** 新建节点（文件或目录）；名称支持 a/b/c（自动建中间目录） */
export async function createNode(
  projectId: string,
  parentId: string | null,
  rawName: string,
  type: 'file' | 'dir',
  content: string,
): Promise<TreeNode> {
  const name = normalizeName(rawName);
  if (!name || name.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error('invalid_name');
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    let base = '';
    if (parentId) {
      const p = await client.query<{ path: string; type: string }>(
        'select path, type from files where id = $1 and project_id = $2',
        [parentId, projectId],
      );
      if (!p.rowCount) throw new Error('parent_not_found');
      if (p.rows[0].type !== 'dir') throw new Error('parent_not_dir');
      base = p.rows[0].path;
    }
    const full = base ? `${base}/${name}` : name;
    const segs = full.split('/');
    const leaf = segs[segs.length - 1];
    const pid = await ensureDirPath(client, projectId, segs.slice(0, -1).join('/'));
    const dup = await client.query(
      'select 1 from files where project_id = $1 and path = $2',
      [projectId, full],
    );
    if (dup.rowCount) throw new Error('exists');
    const ins = await client.query<TreeNode>(
      `insert into files (project_id, pid, name, type, path, content)
       values ($1, $2, $3, $4, $5, $6)
       returning id, pid, name, type, path, version`,
      [projectId, pid, leaf, type, full, type === 'file' ? content : null],
    );
    await client.query('commit');
    return ins.rows[0];
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** 保存文件内容（乐观锁：version 不符返回 conflict） */
export async function updateFile(
  projectId: string,
  id: string,
  content: string,
  version: number,
) {
  const client = await pool.connect();
  try {
    const r = await client.query<{ version: number }>(
      `update files set content = $1, version = version + 1, updated_at = now()
        where id = $2 and project_id = $3 and type = 'file' and version = $4
        returning version`,
      [content, id, projectId, version],
    );
    if (!r.rowCount) throw new Error('conflict');
    return { version: r.rows[0].version };
  } finally {
    client.release();
  }
}

/** 重命名/移动（目录递归改子树 path），返回移前→移后的路径映射 */
export async function renameNode(
  projectId: string,
  id: string,
  newName: string,
  newParentId?: string | null,
): Promise<{ path: string; moves: { from: string; to: string }[] }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const node = (
      await client.query<{ id: string; pid: string | null; type: string; path: string }>(
        'select id, pid, type, path from files where id = $1 and project_id = $2',
        [id, projectId],
      )
    ).rows[0];
    if (!node) throw new Error('not_found');

    let base = '';
    const targetParent = newParentId === undefined ? node.pid : (newParentId ?? null);
    if (targetParent) {
      const p = await client.query<{ path: string; type: string }>(
        'select path, type from files where id = $1 and project_id = $2',
        [targetParent, projectId],
      );
      if (!p.rowCount || p.rows[0].type !== 'dir') throw new Error('parent_not_dir');
      base = p.rows[0].path;
    }
    const newPath = base ? `${base}/${newName}` : newName;
    const oldPath = node.path;

    const dup = await client.query(
      'select 1 from files where project_id = $1 and path = $2 and id <> $3',
      [projectId, newPath, id],
    );
    if (dup.rowCount) throw new Error('exists');

    await client.query(
      'update files set pid = $1, name = $2, path = $3, updated_at = now() where id = $4',
      [targetParent, newName, newPath, id],
    );
    const moves: { from: string; to: string }[] = [];
    if (node.type === 'dir') {
      const desc = await client.query<{ path: string }>(
        `select path from files where project_id = $1 and path like $2 || '/%'`,
        [projectId, oldPath],
      );
      for (const d of desc.rows) {
        moves.push({ from: d.path, to: newPath + d.path.slice(oldPath.length) });
      }
      await client.query(
        `update files
            set path = $1 || substring(path from length($2) + 1), updated_at = now()
          where project_id = $3 and path like $2 || '/%'`,
        [newPath, oldPath, projectId],
      );
    } else {
      moves.push({ from: oldPath, to: newPath });
    }
    await client.query('commit');
    return { path: newPath, moves };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** 删除节点（目录递归），返回被删文件节点（供沙箱同步清理） */
export async function deleteNode(
  projectId: string,
  id: string,
): Promise<{ files: string[] }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const node = (
      await client.query<{ type: string; path: string }>(
        'select type, path from files where id = $1 and project_id = $2',
        [id, projectId],
      )
    ).rows[0];
    if (!node) throw new Error('not_found');

    const victims = await client.query<{ path: string }>(
      node.type === 'dir'
        ? `select path from files
            where project_id = $1 and type = 'file' and (path = $2 or path like $2 || '/%')`
        : `select path from files where project_id = $1 and type = 'file' and id = $2`,
      [projectId, node.type === 'dir' ? node.path : id],
    );

    if (node.type === 'dir') {
      await client.query(
        `delete from files
          where project_id = $1 and (path = $2 or path like $2 || '/%')`,
        [projectId, node.path],
      );
    } else {
      await client.query('delete from files where id = $1', [id]);
    }
    await client.query('commit');
    return { files: victims.rows.map((r) => r.path) };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
