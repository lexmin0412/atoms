import { describe, it, expect } from 'vitest';

import { applyEdit } from './edit';

describe('applyEdit', () => {
  it('替换第一处匹配，保留其余内容', () => {
    expect(applyEdit('a b a', 'a', 'x')).toBe('x b a');
    expect(applyEdit('line1\nline2\nline3', 'line2', 'LINE2')).toBe(
      'line1\nLINE2\nline3',
    );
  });

  it('old_string 不存在时报错', () => {
    expect(() => applyEdit('abc', 'zzz', 'y')).toThrow(/not found/);
  });

  it('空 old_string 直接报错（避免误替换）', () => {
    expect(() => applyEdit('abc', '', 'y')).toThrow(/empty/);
  });
});
