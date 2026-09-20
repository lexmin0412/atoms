import { describe, expect, it } from 'vitest';

import { secretFindings } from './redact';
import {
  MAX_SKILLS_PER_USER,
  normalizeInput,
  SkillError,
  toDto,
  type SkillRow,
} from './skills';
import {
  BUILTIN_SKILLS,
  builtinByName,
  builtinId,
  builtinNames,
  isBuiltinId,
} from './skills/builtin';

/** 取抛出错误（避免在 catch 里写 expect，触发 no-conditional-expect） */
function caught(fn: () => unknown): SkillError {
  try {
    fn();
  } catch (err) {
    return err as SkillError;
  }
  throw new Error('预期会抛出 SkillError，但没有抛');
}

const ok = {
  name: '后台表格规范',
  description: '涉及列表/分页的后台页面时使用',
  body: '## 规范\n- 必须支持分页',
};

describe('skills.normalizeInput', () => {
  it('接受合法输入并归一化（trim）', () => {
    const v = normalizeInput({ ...ok, name: '  后台表格规范  ' });
    expect(v.name).toBe('后台表格规范');
    expect(v.secretFlags).toEqual([]);
  });

  it('名称/适用场景/正文都不能为空', () => {
    expect(() => normalizeInput({ ...ok, name: '' })).toThrow(SkillError);
    expect(() => normalizeInput({ ...ok, description: '   ' })).toThrow(SkillError);
    expect(() => normalizeInput({ ...ok, body: '' })).toThrow(SkillError);
  });

  it('适用场景必填（自动命中依赖它）', () => {
    expect(caught(() => normalizeInput({ ...ok, description: '' })).message).toContain(
      '适用场景',
    );
  });

  it('扫描正文里的疑似密钥（只标识，不阻断）', () => {
    const v = normalizeInput({
      ...ok,
      body: '连接串：postgres://user:pass@10.0.0.1:5432/db\nAPI_KEY=abcdef123456',
    });
    expect(v.secretFlags.length).toBeGreaterThan(0);
    expect(v.secretFlags).toContain('数据库连接串');
  });
});

describe('secretFindings', () => {
  it('识别五类特征', () => {
    expect(secretFindings('postgres://u:p@h:5432/x')).toContain('数据库连接串');
    expect(secretFindings('-----BEGIN RSA PRIVATE KEY-----')).toContain('私钥');
    expect(secretFindings('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij')).toContain(
      'JWT',
    );
    expect(secretFindings('token: abcdef123456')).toContain('疑似密钥（key=value）');
  });

  it('干净文本不报', () => {
    expect(secretFindings('## 规范\n- 表格必须分页')).toEqual([]);
  });

  it('正则状态可复用（连续调用结果一致）', () => {
    const t = 'postgres://u:p@h:5432/x';
    expect(secretFindings(t)).toEqual(secretFindings(t));
  });
});

describe('skills.toDto', () => {
  it('把用户级/项目级映射成 scope', () => {
    const base = {
      id: '1',
      user_id: 'u',
      name: 'n',
      description: 'd',
      body: 'b',
      secret_flags: [],
      created_at: 't',
      updated_at: 't',
    } as unknown as SkillRow;
    expect(toDto({ ...base, project_id: null }).scope).toBe('user');
    expect(toDto({ ...base, project_id: 'p' }).scope).toBe('project');
  });
});

describe('限额常量', () => {
  it('每用户 20 个', () => {
    expect(MAX_SKILLS_PER_USER).toBe(20);
  });
});

describe('内置技能', () => {
  it('frontend-design 已随代码加载（含名称/适用场景/正文）', () => {
    const s = BUILTIN_SKILLS.find((b) => b.key === 'frontend-design');
    expect(s).toBeTruthy();
    expect(s?.name).toBe('frontend-design');
    expect(s?.description.length).toBeGreaterThan(10);
    expect(s?.body.length ?? 0).toBeGreaterThan(500);
  });

  it('id 用 builtin: 前缀，便于识别与拒绝写入', () => {
    expect(builtinId('frontend-design')).toBe('builtin:frontend-design');
    expect(isBuiltinId('builtin:frontend-design')).toBe(true);
    expect(isBuiltinId('3f2a1c9e-0000-0000-0000-000000000000')).toBe(false);
  });

  it('按名字查内置（不区分大小写）', () => {
    expect(builtinByName('Frontend-Design')?.key).toBe('frontend-design');
    expect(builtinByName('  frontend-design ')).toBeTruthy();
    expect(builtinByName('不存在的技能')).toBeNull();
  });

  it('内置名字被占用（用户不得重名）', () => {
    expect(builtinNames()).toContain('frontend-design');
  });

  it('正文里的 frontmatter 已被剥离，且不含对其它产品的自称', () => {
    const s = BUILTIN_SKILLS[0];
    expect(s.body.startsWith('---')).toBe(false);
    expect(s.body).not.toContain('Claude');
  });
});
