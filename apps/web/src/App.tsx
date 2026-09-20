import type { UserDto } from '@atoms/shared';
import { useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { api, UNAUTHORIZED_EVENT } from './lib/api';
import Chat from './pages/Chat';
import Credits from './pages/Credits';
import Login from './pages/Login';
import Projects from './pages/Projects';

function Shell({ user, onLogout }: { user: UserDto; onLogout: () => void }) {
  const { pathname } = useLocation();
  // 工作台自带全高布局，不做外层滚动
  const bare = pathname.startsWith('/p/');
  return (
    <AppShell user={user} onLogout={onLogout} bare={bare}>
      <Outlet />
    </AppShell>
  );
}

export default function App() {
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);
  /** 会话过期时的提示，登录页展示 */
  const [sessionNote, setSessionNote] = useState('');

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // 任意请求遇到 401（会话过期）都在这里统一处理
  useEffect(() => {
    const onUnauthorized = () => {
      setUser((u) => {
        if (u) setSessionNote('登录已过期，请重新登录');
        return null;
      });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  function logout() {
    // 必须调用服务端登出：否则 cookie 仍在，刷新页面会「自动重新登录」
    void api.logout().catch(() => {});
    setUser(null);
  }

  if (loading) {
    return (
      <div className="blueprint grid h-full place-items-center">
        <div className="text-muted-foreground flex items-center gap-2.5 text-[13px]">
          <span className="border-border-strong size-3.5 animate-spin rounded-full border-[1.5px] border-t-transparent" />
          加载中
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route
          path="/login"
          element={
            <Login
              note={sessionNote}
              onLogin={(u) => {
                setSessionNote('');
                setUser(u);
              }}
            />
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<Shell user={user} onLogout={logout} />}>
        <Route path="/" element={<Projects />} />
        <Route path="/p/:id" element={<Chat />} />
        <Route path="/credits" element={<Credits />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
