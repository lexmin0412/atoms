import type { UserDto } from '@atoms/shared';
import { useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { api } from './lib/api';
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

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

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
        <Route path="/login" element={<Login onLogin={setUser} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<Shell user={user} onLogout={() => setUser(null)} />}>
        <Route path="/" element={<Projects />} />
        <Route path="/p/:id" element={<Chat />} />
        <Route path="/credits" element={<Credits />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
