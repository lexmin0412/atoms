import type { UserDto } from '@atoms/shared';
import { useState } from 'react';

import { ThemeToggle } from '../components/ThemeToggle';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { IconArrowRight } from '../components/ui/icons';
import { AtomsMark } from '../components/ui/Logo';
import { api } from '../lib/api';

const POINTS = [
  ['对话即应用', '用自然语言描述需求，Agent 直接写代码'],
  ['真实沙箱', '隔离环境里装依赖、构建、运行'],
  ['一键发布', '生成可分享的独立应用地址'],
];

export default function Login({
  onLogin,
  note,
}: {
  onLogin: (u: UserDto) => void;
  /** 会话过期等引导文案（来自 App） */
  note?: string;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r =
        mode === 'login'
          ? await api.login({ email, password })
          : await api.register({ email, username, password });
      onLogin(r.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : '出错了');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="blueprint relative flex min-h-full items-center justify-center p-6">
      <div className="absolute top-5 right-5">
        <ThemeToggle />
      </div>

      <div className="panel-raised grid w-full max-w-4xl overflow-hidden md:grid-cols-[1.05fr_1fr]">
        {/* 品牌面板 */}
        <div className="relative hidden flex-col justify-between p-9 md:flex">
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.55]"
            style={{
              backgroundImage:
                'linear-gradient(var(--grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--grid-line) 1px, transparent 1px)',
              backgroundSize: 'var(--grid-size) var(--grid-size)',
            }}
            aria-hidden
          />
          <div className="relative">
            <span style={{ color: 'var(--accent)' }}>
              <AtomsMark size={30} />
            </span>
            <h1 className="mt-5 text-[26px] leading-tight font-semibold tracking-[-0.02em]">
              Atoms
            </h1>
            <p className="text-muted-foreground mt-2 max-w-[22ch] text-[13.5px] leading-relaxed">
              把一句话的想法，拆成最小单元，组装成一个真正能跑的应用。
            </p>
          </div>

          <ul className="relative mt-10 space-y-3.5">
            {POINTS.map(([t, d]) => (
              <li key={t} className="flex gap-3">
                <span
                  className="mt-1.5 size-1.5 shrink-0 rounded-full"
                  style={{ background: 'var(--accent)' }}
                  aria-hidden
                />
                <div>
                  <p className="text-[13px] font-medium">{t}</p>
                  <p className="text-muted-foreground mt-0.5 text-[12.5px]">{d}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* 表单面板 */}
        <div className="border-border p-6 md:border-l md:p-9">
          <div className="mb-6 flex items-center gap-2 md:hidden">
            <span style={{ color: 'var(--accent)' }}>
              <AtomsMark size={22} />
            </span>
            <span className="text-[15px] font-semibold tracking-[-0.02em]">Atoms</span>
          </div>

          <div className="mb-6">
            <h2 className="text-[17px] font-semibold tracking-[-0.01em]">
              {mode === 'login' ? '登录' : '创建账号'}
            </h2>
            <p className="text-muted-foreground mt-1 text-[12.5px]">
              {mode === 'login' ? '继续你的项目' : '注册后即可开始生成应用'}
            </p>
          </div>

          <form onSubmit={submit} className="space-y-3.5">
            <Field
              label="邮箱"
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {mode === 'register' && (
              <Field
                label="用户名"
                required
                placeholder="怎么称呼你"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            )}
            <Field
              label="密码"
              type="password"
              required
              placeholder="至少 6 位"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            {!error && note && (
              <p className="border-warn/30 bg-warn/8 text-muted-foreground rounded-sm border px-2.5 py-1.5 text-[12.5px]">
                {note}
              </p>
            )}

            {error && (
              <p className="border-danger/30 bg-danger/8 text-danger rounded-sm border px-2.5 py-1.5 text-[12.5px] break-words">
                {error}
              </p>
            )}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              {mode === 'login' ? '登录' : '注册并登录'}
              <IconArrowRight />
            </Button>
          </form>

          <button
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError('');
            }}
            className="text-muted-foreground hover:text-foreground mt-5 text-[12.5px] transition-colors"
          >
            {mode === 'login' ? '还没有账号？创建一个' : '已有账号？去登录'}
          </button>
        </div>
      </div>
    </div>
  );
}
