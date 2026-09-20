import { flattenTree } from '@atoms/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type TreeNode } from '../lib/api';
import { cx } from '../lib/cx';
import CodeEditor from './CodeEditor';
import { Button } from './ui/Button';
import { ConfirmDialog } from './ui/confirm';
import { Field } from './ui/Field';
import { FileIcon, FolderIcon } from './ui/FileIcon';
import { IconButton } from './ui/IconButton';
import { IconFilePlus, IconFolderPlus } from './ui/icons';

interface Props {
  projectId: string;
  /** 生成中：禁止一切写操作 */
  busy: boolean;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={'transition-transform duration-100 ' + (open ? 'rotate-90' : '')}
      aria-hidden
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function IconSave() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3h10L20 7.5v12A1.5 1.5 0 0 1 18.5 21h-13A1.5 1.5 0 0 1 4 19.5v-15Z" />
      <path d="M8 3v5.5h7V3M8 21v-6h8v6" />
    </svg>
  );
}

function IconReload() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 12a8 8 0 1 0 2.3-5.7" />
      <path d="M4 5v6h6" />
    </svg>
  );
}

function IconBuild() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14.5 5.5a4 4 0 0 0 5 5L21 12l-8.5 8.5a2.1 2.1 0 0 1-3-3L18 9" />
      <path d="m6.5 6.5 3 3" />
    </svg>
  );
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
  /** 文件树加载失败（与「真的没文件」区分开） */
  const [treeError, setTreeError] = useState('');
  const [deleting, setDeleting] = useState<TreeNode | null>(null);

  const flat = useMemo(() => flattenTree(nodes, expanded), [nodes, expanded]);
  const activeNode = nodes.find((n) => n.id === activeId) ?? null;

  const refresh = useCallback(
    async (keepActiveId: string | null) => {
      try {
        const r = await api.tree(projectId);
        setNodes(r.nodes);
        setTreeError('');
        if (keepActiveId && !r.nodes.some((n) => n.id === keepActiveId)) {
          setActiveId(null);
          setContent('');
          setDirty(false);
        }
      } catch (err) {
        // 刷新失败保留旧树，只提示（清空会让人以为文件都没了）
        setTreeError(err instanceof Error ? err.message : '文件列表刷新失败');
      }
    },
    [projectId],
  );

  const loadTree = useCallback(async () => {
    try {
      const r = await api.tree(projectId);
      setNodes(r.nodes);
      setTreeError('');
    } catch (err) {
      setTreeError(err instanceof Error ? err.message : '文件列表加载失败');
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    api
      .tree(projectId)
      .then((r) => {
        if (cancelled) return;
        setNodes(r.nodes);
        setTreeError('');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTreeError(err instanceof Error ? err.message : '文件列表加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const openFile = useCallback(
    async (node: TreeNode) => {
      if (node.type !== 'file') return;
      setMenu(null);
      try {
        const r = await api.file(projectId, node.path);
        setActiveId(node.id);
        setContent(r.content);
        setVersion(r.version);
        setDirty(false);
        setNotice('');
      } catch (err) {
        // 读不到就不要打开空编辑器：否则用户一保存就把原文件覆盖成空白
        setActiveId(null);
        setContent('');
        setDirty(false);
        setNotice(err instanceof Error ? err.message : '文件加载失败，请重试');
      }
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
    try {
      const r = await api.file(projectId, activeNode.path);
      setContent(r.content);
      setVersion(r.version);
      setDirty(false);
      setNotice('已重新加载');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '重新加载失败');
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
    try {
      await api.deleteNode(projectId, node.id);
      await refresh(activeId);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(null);
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
      {/* 工具栏 */}
      <div className="border-border flex h-10 shrink-0 items-center gap-1.5 border-b px-2.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={locked}
          onClick={() => toolbarAction('file')}
        >
          <IconFilePlus size={14} />
          文件
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={locked}
          onClick={() => toolbarAction('dir')}
        >
          <IconFolderPlus size={14} />
          目录
        </Button>
        <div className="ml-auto">
          <IconButton
            label={rebuilding ? '构建中…' : '重新构建（前端构建 + 重启后端）'}
            icon={<IconBuild />}
            side="left"
            disabled={locked || rebuilding}
            onClick={rebuild}
          />
        </div>
      </div>

      {locked && (
        <div className="border-warn/30 bg-warn/10 text-warn flex items-center gap-2 border-b px-2.5 py-1 text-[11.5px]">
          <span className="size-1.5 rounded-full" style={{ background: 'var(--warn)' }} />
          生成中，暂不能编辑文件
        </div>
      )}
      {notice && (
        <div className="border-border bg-muted/50 text-muted-foreground flex items-center gap-2 border-b px-2.5 py-1 text-[11.5px]">
          <span className="truncate">{notice}</span>
          <button
            onClick={() => setNotice('')}
            className="hover:text-foreground ml-auto shrink-0"
          >
            ×
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 文件树 */}
        <div
          className="border-border w-36 shrink-0 overflow-y-auto border-r py-1.5 sm:w-52"
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, node: null });
          }}
        >
          {treeError && (
            <div className="px-3 py-1 text-[11.5px]">
              <p className="text-danger break-words">{treeError}</p>
              <button
                className="text-muted-foreground mt-1 underline hover:opacity-100"
                onClick={() => void loadTree()}
              >
                重试
              </button>
            </div>
          )}
          {!treeError && flat.length === 0 && (
            <p className="text-muted-foreground px-3 py-1 text-[11.5px]">暂无文件</p>
          )}
          {flat.map(({ node: n, depth }) => (
            <div
              key={n.id}
              onClick={() => (n.type === 'dir' ? toggle(n.id) : openFile(n))}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, node: n });
              }}
              className={cx(
                'group flex h-9 cursor-pointer items-center gap-1 pr-1.5 text-[12.5px] transition-colors sm:h-[22px]',
                activeId === n.id
                  ? 'bg-accent/10 text-accent'
                  : 'text-foreground/85 hover:bg-muted hover:text-foreground',
              )}
              style={{ paddingLeft: 6 + depth * 10 }}
              title={n.path}
            >
              <span className="text-muted-foreground grid size-4 shrink-0 place-items-center">
                {n.type === 'dir' ? <Chevron open={expanded.has(n.id)} /> : null}
              </span>
              <span className="grid size-4 shrink-0 place-items-center">
                {n.type === 'dir' ? (
                  <FolderIcon open={expanded.has(n.id)} />
                ) : (
                  <FileIcon name={n.name} />
                )}
              </span>
              <span className="truncate">{n.name}</span>
              {!locked && (
                <span className="ml-auto flex shrink-0 gap-0.5 sm:hidden sm:group-hover:flex">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setPrompt({ kind: 'rename', node: n, value: n.name });
                    }}
                    className="text-muted-foreground hover:text-foreground rounded-xs px-1"
                    title="重命名"
                  >
                    ✎
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleting(n);
                    }}
                    className="text-muted-foreground hover:text-danger rounded-xs px-1"
                    title="删除"
                  >
                    ✕
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>

        {/* 编辑器 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {activeNode ? (
            <>
              <div className="border-border flex h-10 shrink-0 items-center gap-2 border-b px-3">
                <span className="text-muted-foreground truncate font-mono text-[11.5px]">
                  {activeNode.path}
                </span>
                {dirty && (
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: 'var(--warn)' }}
                    title="有未保存改动"
                  />
                )}
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  {dirty && (
                    <IconButton
                      label="重新加载（放弃改动）"
                      icon={<IconReload />}
                      onClick={reload}
                    />
                  )}
                  <IconButton
                    label={saving ? '保存中…' : '保存（⌘S）'}
                    icon={<IconSave />}
                    className={dirty ? 'text-accent-ink hover:bg-accent/12' : undefined}
                    disabled={!dirty || locked || saving}
                    onClick={save}
                  />
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
            <div className="grid flex-1 place-items-center">
              <p className="text-muted-foreground text-[12px]">选择文件查看或编辑</p>
            </div>
          )}
        </div>
      </div>

      {/* 右键菜单 */}
      {menu && (
        <div
          className="panel-raised fixed z-50 min-w-36 py-1"
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
              <div className="bg-border my-1 h-px" />
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
                  setDeleting(menu.node!);
                  setMenu(null);
                }}
              />
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!deleting}
        title={`删除${deleting?.type === 'dir' ? '目录' : '文件'}「${deleting?.name ?? ''}」？`}
        description={
          deleting?.type === 'dir'
            ? '该目录下的所有文件都会被一并删除，此操作不可恢复。'
            : '此操作不可恢复。'
        }
        onConfirm={() => {
          if (deleting) return remove(deleting);
        }}
        onCancel={() => setDeleting(null)}
      />

      {/* 命名弹窗 */}
      {prompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-[1px]">
          <div className="panel-raised w-80 p-4">
            <p className="mb-3 text-[13px] font-medium">
              {prompt.kind === 'rename'
                ? '重命名 / 移动'
                : prompt.kind === 'dir'
                  ? '新建目录'
                  : '新建文件'}
            </p>
            <Field
              autoFocus
              value={prompt.value}
              onChange={(e) => setPrompt({ ...prompt, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitPrompt();
                if (e.key === 'Escape') setPrompt(null);
              }}
              placeholder={prompt.kind === 'rename' ? '新名称' : '名称（如 src/app.tsx）'}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPrompt(null)}>
                取消
              </Button>
              <Button size="sm" variant="primary" onClick={submitPrompt}>
                确定
              </Button>
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
      className={cx(
        'block w-full px-3 py-1.5 text-left text-[12.5px] transition-colors disabled:opacity-40',
        danger ? 'text-danger hover:bg-danger/10' : 'hover:bg-muted',
      )}
    >
      {label}
    </button>
  );
}
