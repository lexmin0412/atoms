import { flattenTree } from '@atoms/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type TreeNode } from '../lib/api';
import CodeEditor from './CodeEditor';

interface Props {
  projectId: string;
  /** 生成中：禁止一切写操作 */
  busy: boolean;
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop() ?? '';
  if (['ts', 'tsx'].includes(ext)) return 'TS';
  if (['js', 'jsx', 'mjs'].includes(ext)) return 'JS';
  if (ext === 'json') return '{}';
  if (['md', 'markdown'].includes(ext)) return 'MD';
  if (['css', 'scss'].includes(ext)) return 'CS';
  if (['html', 'htm'].includes(ext)) return '<>';
  return '·';
}

export default function FileManager({ projectId, busy }: Props) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    node: TreeNode | null;
  } | null>(null);
  const [prompt, setPrompt] = useState<{
    kind: 'file' | 'dir' | 'rename';
    node: TreeNode | null;
    value: string;
  } | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  const flat = useMemo(() => flattenTree(nodes, expanded), [nodes, expanded]);
  const activeNode = nodes.find((n) => n.id === activeId) ?? null;

  const refresh = useCallback(
    async (keepActiveId: string | null) => {
      const r = await api.tree(projectId).catch(() => ({ nodes: [], busy: false }));
      setNodes(r.nodes);
      if (keepActiveId && !r.nodes.some((n) => n.id === keepActiveId)) {
        setActiveId(null);
        setContent('');
        setDirty(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .tree(projectId)
      .then((r) => {
        if (!cancelled) setNodes(r.nodes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const openFile = useCallback(
    async (node: TreeNode) => {
      if (node.type !== 'file') return;
      setActiveId(node.id);
      setMenu(null);
      const r = await api
        .file(projectId, node.path)
        .catch(() => ({ path: node.path, content: '', version: node.version }));
      setContent(r.content);
      setVersion(r.version);
      setDirty(false);
      setNotice('');
    },
    [projectId],
  );

  async function save() {
    if (!activeNode || saving || busy) return;
    setSaving(true);
    try {
      const r = await api.saveFile(projectId, activeNode.id, content, version);
      setVersion(r.version);
      setDirty(false);
      setNotice('已保存');
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'conflict') {
        setNotice('文件已被更改，请重新加载后再保存');
      } else {
        setNotice(err instanceof Error ? err.message : '保存失败');
      }
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    if (!activeNode) return;
    const r = await api.file(projectId, activeNode.path).catch(() => null);
    if (r) {
      setContent(r.content);
      setVersion(r.version);
      setDirty(false);
      setNotice('');
    }
  }

  async function submitPrompt() {
    if (!prompt) return;
    const { kind, node, value } = prompt;
    const name = value.trim();
    setPrompt(null);
    if (!name) return;
    try {
      if (kind === 'rename' && node) {
        await api.renameNode(projectId, node.id, name);
        await refresh(activeId);
      } else {
        const parentId = node?.type === 'dir' ? node.id : (node?.pid ?? null);
        if (kind === 'dir') {
          const r = await api.createDir(projectId, { parentId, name });
          setExpanded((s) => new Set(s).add(r.node.id));
        } else {
          const r = await api.createFile(projectId, { parentId, name, content: '' });
          await refresh(activeId);
          await openFile(r.node);
        }
        if (parentId) setExpanded((s) => new Set(s).add(parentId));
        await refresh(activeId);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '操作失败');
    }
  }

  async function remove(node: TreeNode) {
    const what = node.type === 'dir' ? '目录（含全部子文件）' : '文件';
    if (!window.confirm(`确定删除${what} ${node.name}？`)) return;
    try {
      await api.deleteNode(projectId, node.id);
      await refresh(activeId);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '删除失败');
    }
  }

  async function rebuild() {
    if (rebuilding || busy) return;
    setRebuilding(true);
    setNotice('构建中…');
    try {
      await api.rebuild(projectId);
      setNotice('构建完成，预览已更新');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '构建失败');
    } finally {
      setRebuilding(false);
    }
  }

  function toolbarAction(kind: 'file' | 'dir') {
    const target = activeNode?.type === 'dir' ? activeNode : null;
    setPrompt({ kind, node: target, value: '' });
  }

  const locked = busy;

  return (
    <div className="flex min-h-0 flex-1 flex-col" onClick={() => setMenu(null)}>
      <div className="flex items-center gap-1 border-b border-neutral-200 px-2 py-1 dark:border-neutral-800">
        <button
          onClick={() => toolbarAction('file')}
          disabled={locked}
          className="rounded px-1.5 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800"
          title="新建文件"
        >
          + 文件
        </button>
        <button
          onClick={() => toolbarAction('dir')}
          disabled={locked}
          className="rounded px-1.5 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800"
          title="新建目录"
        >
          + 目录
        </button>
        <button
          onClick={rebuild}
          disabled={locked || rebuilding}
          className="ml-auto rounded border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          title="前端构建 + 重启后端"
        >
          {rebuilding ? '构建中…' : '重新构建'}
        </button>
      </div>

      {locked && (
        <div className="border-b border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          生成中，暂不能编辑文件
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          <span className="truncate">{notice}</span>
          <button onClick={() => setNotice('')} className="ml-auto shrink-0">
            ×
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div
          className="w-44 shrink-0 overflow-y-auto border-r border-neutral-200 py-1 text-xs dark:border-neutral-800"
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, node: null });
          }}
        >
          {flat.length === 0 && <p className="px-3 py-1 text-neutral-400">暂无文件</p>}
          {flat.map(({ node: n, depth }) => (
            <div
              key={n.id}
              onClick={() => (n.type === 'dir' ? toggle(n.id) : openFile(n))}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, node: n });
              }}
              className={
                'group flex cursor-pointer items-center gap-1 py-0.5 pr-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 ' +
                (activeId === n.id ? 'bg-neutral-100 dark:bg-neutral-800' : '')
              }
              style={{ paddingLeft: 6 + depth * 12 }}
              title={n.path}
            >
              {n.type === 'dir' ? (
                <span className="w-3 shrink-0 text-neutral-400">
                  {expanded.has(n.id) ? '▾' : '▸'}
                </span>
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <span className="inline-block w-4 shrink-0 text-center font-mono text-[10px] text-neutral-400">
                {n.type === 'dir' ? '' : fileIcon(n.name)}
              </span>
              <span className="truncate">{n.name}</span>
              {!locked && (
                <span className="ml-auto hidden shrink-0 gap-0.5 group-hover:flex">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setPrompt({ kind: 'rename', node: n, value: n.name });
                    }}
                    className="rounded px-1 text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
                    title="重命名"
                  >
                    ✎
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(n);
                    }}
                    className="rounded px-1 text-neutral-400 hover:text-red-500"
                    title="删除"
                  >
                    ✕
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {activeNode ? (
            <>
              <div className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
                <span className="truncate">{activeNode.path}</span>
                {dirty && <span className="text-amber-500">●</span>}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {dirty && (
                    <button
                      onClick={reload}
                      className="rounded px-1.5 py-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-800"
                    >
                      重新加载
                    </button>
                  )}
                  <button
                    onClick={save}
                    disabled={!dirty || saving || locked}
                    className="rounded bg-neutral-900 px-1.5 py-0.5 text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
                  >
                    {saving ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
              <CodeEditor
                path={activeNode.path}
                value={content}
                readOnly={locked}
                onChange={(v) => {
                  setContent(v);
                  setDirty(true);
                  setNotice('');
                }}
                onSave={save}
              />
            </>
          ) : (
            <p className="p-3 text-xs text-neutral-400">选择文件查看或编辑</p>
          )}
        </div>
      </div>

      {menu && (
        <div
          className="fixed z-50 min-w-32 rounded-md border border-neutral-200 bg-white py-1 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem
            label="新建文件"
            disabled={locked}
            onClick={() => {
              setPrompt({ kind: 'file', node: menu.node, value: '' });
              setMenu(null);
            }}
          />
          <MenuItem
            label="新建目录"
            disabled={locked}
            onClick={() => {
              setPrompt({ kind: 'dir', node: menu.node, value: '' });
              setMenu(null);
            }}
          />
          {menu.node && (
            <>
              <MenuItem
                label="重命名 / 移动"
                disabled={locked}
                onClick={() => {
                  setPrompt({ kind: 'rename', node: menu.node, value: menu.node!.name });
                  setMenu(null);
                }}
              />
              <MenuItem
                label="删除"
                danger
                disabled={locked}
                onClick={() => {
                  remove(menu.node!);
                  setMenu(null);
                }}
              />
            </>
          )}
        </div>
      )}

      {prompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
          <div className="w-80 rounded-lg border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
            <p className="mb-2 text-sm font-medium">
              {prompt.kind === 'rename'
                ? '重命名 / 移动'
                : prompt.kind === 'dir'
                  ? '新建目录'
                  : '新建文件'}
            </p>
            <input
              autoFocus
              value={prompt.value}
              onChange={(e) => setPrompt({ ...prompt, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitPrompt();
                if (e.key === 'Escape') setPrompt(null);
              }}
              placeholder={prompt.kind === 'rename' ? '新名称' : '名称（如 src/app.tsx）'}
              className="w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <div className="mt-3 flex justify-end gap-2 text-sm">
              <button
                onClick={() => setPrompt(null)}
                className="rounded px-3 py-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                取消
              </button>
              <button
                onClick={submitPrompt}
                className="rounded bg-neutral-900 px-3 py-1 text-white dark:bg-white dark:text-neutral-900"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  function toggle(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
}

function MenuItem({
  label,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        'block w-full px-3 py-1 text-left hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800 ' +
        (danger ? 'text-red-600 dark:text-red-400' : '')
      }
    >
      {label}
    </button>
  );
}
