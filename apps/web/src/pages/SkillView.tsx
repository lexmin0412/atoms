import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/confirm';
import { api, type SkillDto } from '../lib/api';

/** 只读查看（与聊天区共用 Markdown 渲染，按需加载） */
const Markdown = lazy(() => import('../components/Markdown'));

/**
 * 技能查看页 `/skills/:id`：内置技能也能看（只读）。
 * 单独成页，取代原来列表页上的内联面板。
 */
export default function SkillView() {
  const { id } = useParams();
  const nav = useNavigate();
  const [skill, setSkill] = useState<SkillDto | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!id) return;
    api
      .skill(id)
      .then((r) => {
        if (!cancelled) {
          setSkill(r.skill);
          setError('');
          setLoading(false);
        }
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
  }, [id]);

  async function remove() {
    if (!skill) return;
    try {
      await api.deleteSkill(skill.id);
      nav('/skills', { replace: true });
    } catch (err) {
      setConfirmDelete(false);
      setError(err instanceof Error ? err.message : '删除失败');
    }
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl px-8 py-10">
        <p className="text-muted-foreground text-[12.5px]">加载中…</p>
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="mx-auto w-full max-w-3xl px-8 py-10">
        <Link
          to="/skills"
          className="text-muted-foreground hover:text-foreground text-[12.5px]"
        >
          ← 技能
        </Link>
        <p className="text-danger mt-4 text-[13px] break-words">
          {error || '技能不存在或无权访问'}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-10">
      <div className="mb-6 flex items-center gap-3">
        <Link
          to="/skills"
          className="text-muted-foreground hover:text-foreground text-[12.5px]"
        >
          ← 技能
        </Link>
      </div>

      {error && (
        <div className="border-danger/30 bg-danger/8 text-danger mb-4 rounded-sm border px-3 py-2 text-[12.5px] break-words">
          {error}
        </div>
      )}

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[18px] font-semibold tracking-[-0.02em] break-words">
            {skill.name}
          </h1>
          <p className="text-muted-foreground mt-1.5 text-[12.5px]">
            {skill.description}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {skill.builtin ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                nav('/skills/new', {
                  state: {
                    prefill: {
                      name: `${skill.name}-副本`,
                      description: skill.description,
                      body: skill.body,
                    },
                  },
                })
              }
            >
              复制为我的
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => nav(`/skills/${skill.id}/edit`)}
              >
                编辑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                onClick={() => setConfirmDelete(true)}
              >
                删除
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        {skill.builtin ? (
          <Badge tone="accent">内置（不可修改）</Badge>
        ) : (
          <Badge tone={skill.scope === 'project' ? 'accent' : 'neutral'}>
            {skill.scope === 'project' ? '仅本项目' : '所有项目'}
          </Badge>
        )}
      </div>

      {skill.secretFlags.length > 0 && (
        <p className="border-warn/30 bg-warn/8 text-muted-foreground mt-3 rounded-sm border px-3 py-2 text-[12px]">
          ⚠️ 内容疑似包含{skill.secretFlags.join('、')}
          。技能正文会发送给模型服务并可能被写进代码， 请确认这不是真实密钥。
        </p>
      )}

      <div className="panel mt-4 px-4 py-3">
        <Suspense fallback={<p className="text-muted-foreground text-[12px]">加载中…</p>}>
          <Markdown text={skill.body} />
        </Suspense>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={`删除技能「${skill.name}」？`}
        description="删除后 Agent 就看不到它了，无法恢复。"
        confirmText="删除"
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
