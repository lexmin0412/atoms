import { useCallback, useEffect, useState } from 'react';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/confirm';
import { IconPlus, IconSparkle } from '../components/ui/icons';
import { api, type SkillDto, type SkillInput } from '../lib/api';
import { cx } from '../lib/cx';

/**
 * 技能管理（用户级 + 项目级）。
 * 作为全局页面用时不传 projectId；作为项目页签用时传 projectId。
 *
 * 技能是「知识」：正文会作为参考资料注入给 Agent。
 * 保存时服务端会扫描疑似凭据并打标识（不阻断），这里把标识显式展示出来。
 */

/** 客户端粗检：只为编辑时即时提示，权威判定在服务端 */
function quickSecretHint(text: string): boolean {
  return (
    /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\//i.test(text) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(text) ||
    /(api[_-]?key|secret[_-]?key|access[_-]?key|password|passwd|token|bearer)\s*[:=]\s*\S{6,}/i.test(
      text,
    )
  );
}

function Counter({ len, max }: { len: number; max: number }) {
  return (
    <span
      className={cx(
        'ml-auto text-[11px] tabular-nums',
        len > max ? 'text-danger font-medium' : 'text-muted-foreground/70',
      )}
    >
      {len}/{max}
    </span>
  );
}

const EMPTY: SkillInput = { name: '', description: '', body: '' };
/** 与后端上限保持一致的兜底值（真实值由接口返回） */
const DEFAULT_LIMITS = { name: 60, description: 200, body: 20_000 };

export default function Skills({
  projectId,
  embedded = false,
}: {
  projectId?: string;
  embedded?: boolean;
}) {
  const [list, setList] = useState<SkillDto[] | null>(null);
  const [limit, setLimit] = useState(20);
  const [limits, setLimits] = useState(DEFAULT_LIMITS);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<{ id: string | null; draft: SkillInput } | null>(
    null,
  );
  const [scope, setScope] = useState<'user' | 'project'>(projectId ? 'project' : 'user');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<SkillDto | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.skills(projectId);
      setList(r.skills);
      setLimit(r.limit);
      if (r.limits) setLimits(r.limits);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '技能列表加载失败');
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    api
      .skills(projectId)
      .then((r) => {
        if (cancelled) return;
        setList(r.skills);
        setLimit(r.limit);
        if (r.limits) setLimits(r.limits);
        setError('');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '技能列表加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function startCreate() {
    setScope(projectId ? 'project' : 'user');
    setNotice('');
    setEditing({ id: null, draft: { ...EMPTY } });
  }

  function startEdit(s: SkillDto) {
    setScope(s.scope);
    setNotice('');
    setEditing({
      id: s.id,
      draft: { name: s.name, description: s.description, body: s.body },
    });
  }

  async function save() {
    if (!editing || busy) return;
    const draft = editing.draft;
    // 先本地拦一道：给出「哪个字段、多少字」，不让人对着笼统提示猜
    const problems: string[] = [];
    if (!draft.name.trim()) problems.push('名称不能为空');
    else if (draft.name.trim().length > limits.name) {
      problems.push(
        `名称过长（上限 ${limits.name} 字，当前 ${draft.name.trim().length} 字）`,
      );
    }
    if (!draft.description.trim()) problems.push('适用场景不能为空');
    else if (draft.description.trim().length > limits.description) {
      problems.push(
        `适用场景过长（上限 ${limits.description} 字，当前 ${draft.description.trim().length} 字）`,
      );
    }
    if (!draft.body.trim()) problems.push('内容不能为空');
    else if (draft.body.length > limits.body) {
      problems.push(`内容过长（上限 ${limits.body} 字，当前 ${draft.body.length} 字）`);
    }
    if (problems.length) {
      setError(problems.join('；'));
      return;
    }
    setBusy(true);
    try {
      if (editing.id) {
        const r = await api.updateSkill(editing.id, draft);
        setNotice(
          r.skill.secretFlags.length
            ? `已保存。⚠️ 检测到疑似${r.skill.secretFlags.join('、')}`
            : '已保存',
        );
      } else {
        const r = await api.createSkill({
          ...draft,
          projectId: scope === 'project' ? (projectId ?? null) : null,
        });
        setNotice(
          r.skill.secretFlags.length
            ? `已保存。⚠️ 检测到疑似${r.skill.secretFlags.join('、')}`
            : '已保存',
        );
      }
      setEditing(null);
      setError('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: SkillDto) {
    try {
      await api.deleteSkill(s.id);
      setRemoving(null);
      await load();
    } catch (err) {
      setRemoving(null);
      setError(err instanceof Error ? err.message : '删除失败');
    }
  }

  const reachedLimit = (list?.length ?? 0) >= limit;
  const hint = editing
    ? quickSecretHint(`${editing.draft.name}\n${editing.draft.body}`)
    : false;

  return (
    <div
      className={cx(
        'flex min-h-0 flex-1 flex-col',
        !embedded && 'mx-auto w-full max-w-4xl',
      )}
    >
      <div
        className={cx('flex items-center gap-3', embedded ? 'px-4 pt-4' : 'pt-10 pb-6')}
      >
        <div className="min-w-0 flex-1">
          <h1 className="text-[18px] font-semibold tracking-[-0.02em]">技能</h1>
          <p className="text-muted-foreground mt-1 text-[12.5px]">
            把你项目/团队的规范写成技能，Agent 会按需参考。
            {list ? `（${list.length} / ${limit}）` : ''}
          </p>
        </div>
        <Button variant="primary" onClick={startCreate} disabled={reachedLimit}>
          <IconPlus />
          新建技能
        </Button>
      </div>

      <div
        className={cx(
          'mt-2 min-h-0 flex-1 overflow-y-auto',
          embedded ? 'px-4 pb-4' : 'pb-10',
        )}
      >
        {error && (
          <div className="border-danger/30 bg-danger/8 text-danger mb-3 flex items-start gap-2 rounded-sm border px-3 py-2 text-[12.5px]">
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button className="shrink-0 underline" onClick={() => setError('')}>
              关闭
            </button>
          </div>
        )}
        {notice && (
          <div className="border-border bg-muted/50 text-muted-foreground mb-3 flex items-start gap-2 rounded-sm border px-3 py-2 text-[12.5px]">
            <span className="min-w-0 flex-1 break-words">{notice}</span>
            <button className="shrink-0 underline" onClick={() => setNotice('')}>
              关闭
            </button>
          </div>
        )}
        {reachedLimit && (
          <p className="text-muted-foreground mb-3 text-[12px]">
            已达上限 {limit} 个，删除一些后才能继续新建。
          </p>
        )}

        {editing && (
          <div className="panel mb-4 p-4">
            <p className="mb-3 text-[13px] font-medium">
              {editing.id ? '编辑技能' : '新建技能'}
            </p>
            {!editing.id && projectId && (
              <div className="mb-3 flex items-center gap-2 text-[12px]">
                <span className="text-muted-foreground">作用范围</span>
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as 'user' | 'project')}
                  className="border-border bg-surface rounded-sm border px-2 py-1 text-[12px]"
                >
                  <option value="project">仅本项目</option>
                  <option value="user">所有项目</option>
                </select>
              </div>
            )}
            <label className="mb-3 block">
              <span className="text-muted-foreground mb-1.5 flex items-center gap-2 text-[12px] font-medium">
                名称
                <Counter len={editing.draft.name.length} max={limits.name} />
              </span>
              <input
                value={editing.draft.name}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    draft: { ...editing.draft, name: e.target.value },
                  })
                }
                placeholder="例如：后台表格规范"
                className="border-border bg-surface focus:border-ring w-full rounded-sm border px-2.5 py-1.5 text-[13px] outline-none"
              />
            </label>
            <label className="mb-3 block">
              <span className="text-muted-foreground mb-1.5 flex items-center gap-2 text-[12px] font-medium">
                适用场景
                <span className="text-muted-foreground/70 font-normal">
                  （Agent 靠它判断什么时候该用）
                </span>
                <Counter
                  len={editing.draft.description.length}
                  max={limits.description}
                />
              </span>
              <input
                value={editing.draft.description}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    draft: { ...editing.draft, description: e.target.value },
                  })
                }
                placeholder="例如：涉及列表/表单/分页的后台页面时使用"
                className="border-border bg-surface focus:border-ring w-full rounded-sm border px-2.5 py-1.5 text-[13px] outline-none"
              />
            </label>
            <label className="mb-3 block">
              <span className="text-muted-foreground mb-1.5 flex items-center gap-2 text-[12px] font-medium">
                内容（Markdown）
                <Counter len={editing.draft.body.length} max={limits.body} />
              </span>
              <textarea
                value={editing.draft.body}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    draft: { ...editing.draft, body: e.target.value },
                  })
                }
                rows={12}
                placeholder={'## 规范\n- 表格必须支持分页\n- 空态必须有引导文案'}
                className="border-border bg-surface focus:border-ring w-full resize-y rounded-sm border px-2.5 py-2 font-mono text-[12.5px] leading-relaxed outline-none"
              />
            </label>
            {hint && (
              <p className="border-warn/30 bg-warn/8 text-muted-foreground mt-3 rounded-sm border px-2.5 py-2 text-[12px]">
                ⚠️ 内容里疑似包含密钥。技能正文会发送给模型服务并可能被写进代码，
                请确认这不是真实密钥。
              </p>
            )}

            <div className="mt-4 flex items-center gap-2">
              <Button variant="primary" loading={busy} onClick={save}>
                保存
              </Button>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                取消
              </Button>
            </div>
          </div>
        )}

        {list && list.length === 0 && !editing && (
          <div className="panel flex flex-col items-center px-6 py-16 text-center">
            <span className="text-muted-foreground/45">
              <IconSparkle size={26} />
            </span>
            <p className="mt-3 text-[13px] font-medium">还没有技能</p>
            <p className="text-muted-foreground mt-1.5 max-w-[40ch] text-[12px] leading-relaxed">
              把「你希望 Agent 每次都遵守的规范」写成一个技能，之后在对话里用 / 唤起它，
              或者让 Agent 自己按适用场景命中。技能里用到的命令行工具，Agent
              会在沙箱里自己装。
            </p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {(list ?? []).map((s) => (
            <div key={s.id} className="panel p-3.5">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {s.name}
                </span>
                <Badge tone={s.scope === 'project' ? 'accent' : 'neutral'}>
                  {s.scope === 'project' ? '本项目' : '所有项目'}
                </Badge>
              </div>
              <p className="text-muted-foreground mt-1.5 line-clamp-2 text-[12px]">
                {s.description}
              </p>
              {s.secretFlags.length > 0 && (
                <p className="border-warn/30 bg-warn/8 text-warn mt-2 rounded-xs border px-2 py-1 text-[11px]">
                  ⚠️ 疑似{s.secretFlags.join('、')}
                </p>
              )}
              <div className="mt-3 flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => startEdit(s)}>
                  编辑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  onClick={() => setRemoving(s)}
                >
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(removing)}
        title={`删除技能「${removing?.name ?? ''}」？`}
        description="删除后 Agent 就看不到它了，无法恢复。"
        confirmText="删除"
        onConfirm={() => {
          if (removing) void remove(removing);
        }}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
