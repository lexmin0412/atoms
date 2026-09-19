import { describe, expect, it } from 'vitest';

import { flattenTree, type TreeNodeLike } from './index';

const node = (
  id: string,
  pid: string | null,
  name: string,
  type: 'file' | 'dir',
  path: string,
): TreeNodeLike => ({ id, pid, name, type, path });

const nodes: TreeNodeLike[] = [
  node('f1', null, 'readme.md', 'file', 'readme.md'),
  node('d1', null, 'apps', 'dir', 'apps'),
  node('f2', 'd1', 'package.json', 'file', 'apps/package.json'),
  node('d2', 'd1', 'web', 'dir', 'apps/web'),
  node('f3', 'd2', 'index.html', 'file', 'apps/web/index.html'),
  node('f4', 'd2', 'App.tsx', 'file', 'apps/web/App.tsx'),
];

describe('flattenTree', () => {
  it('只显示根节点（目录折叠时）', () => {
    const rows = flattenTree(nodes, new Set());
    expect(rows.map((r) => r.node.name)).toEqual(['apps', 'readme.md']);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });

  it('目录优先，同类按名称排序', () => {
    const rows = flattenTree(nodes, new Set());
    // dir 在前，file 在后
    expect(rows[0].node.type).toBe('dir');
  });

  it('展开目录后按层级递归', () => {
    const rows = flattenTree(nodes, new Set(['d1', 'd2']));
    expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      '0:apps',
      '1:web',
      '2:App.tsx',
      '2:index.html',
      '1:package.json',
      '0:readme.md',
    ]);
  });

  it('展开父目录但不展开子目录', () => {
    const rows = flattenTree(nodes, new Set(['d1']));
    expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      '0:apps',
      '1:web',
      '1:package.json',
      '0:readme.md',
    ]);
  });

  it('忽略孤儿节点（pid 指向不存在的父级）', () => {
    const rows = flattenTree(
      [...nodes, node('x', 'missing', 'orphan', 'file', 'x')],
      new Set(),
    );
    expect(rows.some((r) => r.node.id === 'x')).toBe(false);
  });

  it('空目录展开后不产生影响', () => {
    const rows = flattenTree([node('d', null, 'empty', 'dir', 'empty')], new Set(['d']));
    expect(rows).toHaveLength(1);
    expect(rows[0].depth).toBe(0);
  });
});
