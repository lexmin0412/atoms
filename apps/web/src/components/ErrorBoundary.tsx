import { Component, type ReactNode } from 'react';

import { Button } from './ui/Button';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 渲染期异常兜底。
 * 没有它时，任意组件抛错或 lazy chunk 加载失败都会让 React 卸载整棵树 → 白屏。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('[ui] crashed:', error.message, info?.componentStack);
    // 上报给服务端：生产包是压缩过的，光看 message 定位不到是哪个组件
    void fetch('/api/diag/client', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'error-boundary',
        errorName: error.name,
        errorMessage: error.message,
        stack: (error.stack ?? '').slice(0, 1500),
        componentStack: (info?.componentStack ?? '').slice(0, 1500),
        visibility: document.visibilityState,
        online: navigator.onLine,
        ua: navigator.userAgent,
        url: location.href,
      }),
    }).catch(() => {});
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="blueprint grid h-full min-h-[60vh] place-items-center p-6">
        <div className="panel w-full max-w-md p-6 text-center">
          <h2 className="text-[15px] font-semibold">页面出错了</h2>
          <p className="text-muted-foreground mt-2 text-[13px] break-words">
            {error.message || '发生了未知错误'}
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="primary" onClick={() => window.location.reload()}>
              刷新页面
            </Button>
            <Button variant="ghost" onClick={() => this.setState({ error: null })}>
              返回
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
