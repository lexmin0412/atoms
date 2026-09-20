import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { IconPlus, IconSparkle } from '../components/ui/icons';
import { api, type SkillDto } from '../lib/api';
import { cx } from '../lib/cx';

/**
 * 技能列表（用户级 + 项目级 + 内置）。
 * 新增/查看/编辑都在**独立页面**（`/skills/new`、`/skills/:id`、`/skills/:id/edit`），
 * 本页只负责列表与入口。
 */
export default function Skills({
  projectId,
  embedded = false,
}: {
  projectId?: string;
  embedded?: boolean;
}) {
  const [list, setList] = useState<SkillDto[] | null>(null);
  const [limit, setLimit] = useState(20);
  const [error, setError] = useState('');
  const nav = useNavigate();

  useEffect(() => {
    let cancelled = false;
    api
      .skills(projectId)
      .then((r) => {
        if (cancelled) return;
        setList(r.skills);
        setLimit(r.limit);
        setError('');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '技能列表加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const reachedLimit = (list?.length ?? 0) >= limit;

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
        <Button
          variant="primary"
          disabled={reachedLimit}
          onClick={() =>
            nav(
              projectId
                ? `/skills/new?projectId=${encodeURIComponent(projectId)}`
                : '/skills/new',
            )
          }
        >
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
        {reachedLimit && (
          <p className="text-muted-foreground mb-3 text-[12px]">
            已达上限 {limit} 个，删除一些后才能继续新建。
          </p>
        )}

        {list && list.length === 0 && (
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
            <div key={s.id} className="panel flex flex-col p-3.5">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {s.name}
                </span>
                {/* 操作放右上角 */}
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => nav(`/skills/${s.id}`)}
                  >
                    查看
                  </Button>
                  {s.builtin ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        nav('/skills/new', {
                          state: {
                            prefill: {
                              name: `${s.name}-副本`,
                              description: s.description,
                              body: s.body,
                            },
                          },
                        })
                      }
                    >
                      复制为我的
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => nav(`/skills/${s.id}/edit`)}
                    >
                      编辑
                    </Button>
                  )}
                </div>
              </div>

              <p
                title={s.description}
                className="text-muted-foreground mt-1.5 truncate text-[12px]"
              >
                {s.description}
              </p>

              {s.secretFlags.length > 0 && (
                <p className="border-warn/30 bg-warn/8 text-warn mt-2 rounded-xs border px-2 py-1 text-[11px]">
                  ⚠️ 疑似{s.secretFlags.join('、')}
                </p>
              )}

              {/* 生效范围独占一行放最底部 */}
              <div className="border-border mt-3 flex items-center gap-2 border-t pt-2.5">
                {s.builtin ? (
                  <Badge tone="accent">内置（不可修改）</Badge>
                ) : (
                  <Badge tone={s.scope === 'project' ? 'accent' : 'neutral'}>
                    {s.scope === 'project' ? '本项目' : '所有项目'}
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
