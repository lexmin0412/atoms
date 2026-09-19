import { describe, it, expect } from 'vitest';

import { mimeOf } from './share';

describe('mimeOf', () => {
  it('常见静态资源类型正确', () => {
    expect(mimeOf('index.html')).toContain('text/html');
    expect(mimeOf('assets/app.js')).toContain('text/javascript');
    expect(mimeOf('style.css')).toContain('text/css');
    expect(mimeOf('logo.svg')).toBe('image/svg+xml');
    expect(mimeOf('font.woff2')).toBe('font/woff2');
  });

  it('无扩展名时回退为 html（SPA 路由）', () => {
    expect(mimeOf('some/route')).toContain('text/html');
  });

  it('未知扩展名回退为 octet-stream', () => {
    expect(mimeOf('data.bin')).toBe('application/octet-stream');
  });
});
