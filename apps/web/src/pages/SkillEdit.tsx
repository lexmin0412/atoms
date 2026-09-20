import { useEffect, useState } from 'react';
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { api, type SkillInput } from '../lib/api';

/**
 * 技能编辑页：`/skills/new` 新建、`/skills/:id/edit` 编辑。
 * 单独成页（而不是在列表页塞表单），提交后跳到只读查看页。
 */

const DEFAULT_LIMITS = { name: 60, description: 200, body: 20_000 };

function Counter({ len, max }: { len: number; max: number }) {
  return (
    <span
      className={
        'ml-auto text-[11px] tabular-nums ' +
        (len > max ? 'text-danger font-medium' : 'text-muted-foreground/70')
      }
    >
      {len}/{max}
    </span>
  );
}

export default function SkillEdit() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const location = useLocation();
  const isEdit = Boolean(id);
  /** 「复制为我的」等场景：从上个页面带过来的预填内容 */
  const prefill = (location.state as { prefill?: SkillInput } | null)?.prefill;

  const [draft, setDraft] = useState<SkillInput>(
    prefill ?? { name: '', description: '', body: '' },
  );
  const [scope, setScope] = useState<'user' | 'project'>(
    params.get('projectId') ? 'project' : 'user',
  );
  const [projectId] = useState(params.get('projectId'));
  /** 编辑时作用范围不可改（后端也不支持跨层级搬迁），仅展示 */
  const [fixedScope, setFixedScope] = useState<'user' | 'project' | null>(
    isEdit ? 'user' : null,
  );
  const [limits, setLimits] = useState(DEFAULT_LIMITS);
  const [loading, setLoading] = useState(isEdit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .skills()
      .then((r) => {
        if (!cancelled) setLimits(r.limits ?? DEFAULT_LIMITS);
      })
      .catch(() => {});

    if (!id) {
      // 新建：拿一下上限即可（预填内容已在 state 里）
      if (!prefill) setLoading(false);
      else setLoading(false);
      return;
    }
    api
      .skill(id)
      .then((r) => {
        if (cancelled) return;
        setDraft({
          name: r.skill.name,
          description: r.skill.description,
          body: r.skill.body,
        });
        setScope(r.skill.scope);
        setFixedScope(r.skill.scope);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '技能加载失败');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // prefill 只用于初始化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function save() {
    if (busy) return;
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
      const r = isEdit
        ? await api.updateSkill(id as string, draft)
        : await api.createSkill({
            ...draft,
            projectId: scope === 'project' ? (projectId ?? null) : null,
          });
      nav(`/skills/${r.skill.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
        <p className="text-muted-foreground text-[12.5px]">加载中…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
      <div className="mb-6 flex items-center gap-3">
        <Link
          to="/skills"
          className="text-muted-foreground hover:text-foreground text-[12.5px]"
        >
          ← 技能
        </Link>
        <h1 className="text-[18px] font-semibold tracking-[-0.02em]">
          {isEdit ? '编辑技能' : '新建技能'}
        </h1>
      </div>

      {error && (
        <div className="border-danger/30 bg-danger/8 text-danger mb-4 rounded-sm border px-3 py-2 text-[12.5px] break-words">
          {error}
        </div>
      )}

      {!isEdit && !fixedScope && projectId && (
        <div className="mb-4 flex items-center gap-2 text-[12px]">
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
      {isEdit && fixedScope && (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-muted-foreground text-[12px]">作用范围</span>
          <Badge tone={fixedScope === 'project' ? 'accent' : 'neutral'}>
            {fixedScope === 'project' ? '仅本项目' : '所有项目'}
          </Badge>
        </div>
      )}

      <label className="mb-4 block">
        <span className="text-muted-foreground mb-1.5 flex items-center gap-2 text-[12px] font-medium">
          名称
          <Counter len={draft.name.length} max={limits.name} />
        </span>
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="例如：后台表格规范"
          className="border-border bg-surface focus:border-ring w-full rounded-sm border px-2.5 py-1.5 text-[13px] outline-none"
        />
      </label>

      <label className="mb-4 block">
        <span className="text-muted-foreground mb-1.5 flex items-center gap-2 text-[12px] font-medium">
          适用场景
          <span className="text-muted-foreground/70 font-normal">
            （Agent 靠它判断什么时候该用）
          </span>
          <Counter len={draft.description.length} max={limits.description} />
        </span>
        <input
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="例如：涉及列表/表单/分页的后台页面时使用"
          className="border-border bg-surface focus:border-ring w-full rounded-sm border px-2.5 py-1.5 text-[13px] outline-none"
        />
      </label>

      <label className="block">
        <span className="text-muted-foreground mb-1.5 flex items-center gap-2 text-[12px] font-medium">
          内容（Markdown）
          <Counter len={draft.body.length} max={limits.body} />
        </span>
        <textarea
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          rows={16}
          placeholder={'## 规范\n- 表格必须支持分页\n- 空态必须有引导文案'}
          className="border-border bg-surface focus:border-ring w-full resize-y rounded-sm border px-2.5 py-2 font-mono text-[12.5px] leading-relaxed outline-none"
        />
      </label>

      <p className="text-muted-foreground mt-2 text-[11.5px] leading-relaxed">
        技能正文会进入模型上下文（等于模型服务方能看到），请勿填入真实密钥；
        技能里要用到的命令行工具，Agent 会在沙箱里自己安装。
      </p>

      <div className="mt-5 flex items-center gap-2">
        <Button variant="primary" loading={busy} onClick={save}>
          保存
        </Button>
        <Button variant="ghost" onClick={() => nav('/skills')}>
          取消
        </Button>
      </div>
    </div>
  );
}
