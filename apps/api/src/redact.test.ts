import { describe, expect, it } from 'vitest';

import { forbiddenReason, looksSecret, scrubSecrets } from './redact';

describe('scrubSecrets', () => {
  it('抹掉数据库连接串（含密码）', () => {
    const out = scrubSecrets(
      'DATABASE_URL=postgres://atoms:s3cret@10.0.0.1:9688/atoms_apps',
    );
    expect(out).not.toContain('s3cret');
    expect(out).toContain('[redacted:db-url]');
  });

  it('抹掉 key=value 形式的密钥', () => {
    const out = scrubSecrets('OPENCODE_GO_API_KEY=sk-abcdef123456');
    expect(out).not.toContain('sk-abcdef123456');
    expect(out).toContain('[redacted]');
  });

  it('抹掉私钥块', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    expect(scrubSecrets(pem)).toBe('[redacted:private-key]');
  });

  it('抹掉 JWT 与内部签名头', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk';
    expect(scrubSecrets(`token ${jwt}`)).toContain('[redacted:jwt]');
    expect(scrubSecrets('x-atoms-sig: deadbeef')).toContain('[redacted:signature]');
  });

  it('不动正常文本', () => {
    const t = 'vite v6.4.3 building for production... ✓ built in 2.84s';
    expect(scrubSecrets(t)).toBe(t);
  });
});

describe('forbiddenReason', () => {
  it('拦截读取环境变量的命令', () => {
    expect(forbiddenReason('printenv')).toBeTruthy();
    expect(forbiddenReason('printenv DATABASE_URL')).toBeTruthy();
    expect(forbiddenReason('env')).toBeTruthy();
    expect(forbiddenReason('cat /proc/self/environ')).toBeTruthy();
  });

  it('拦截读取主机信息与容器运行时', () => {
    expect(forbiddenReason('cat /etc/hosts')).toBeTruthy();
    expect(forbiddenReason('cat /etc/shadow')).toBeTruthy();
    expect(forbiddenReason('ls /var/run/docker.sock')).toBeTruthy();
  });

  it('放行正常构建命令', () => {
    expect(forbiddenReason('pnpm install')).toBeNull();
    expect(forbiddenReason('pnpm -r build')).toBeNull();
    expect(forbiddenReason('env CI=true pnpm test')).toBeNull();
  });
});

describe('looksSecret', () => {
  it('识别连接串特征', () => {
    expect(looksSecret('see postgres://u:p@h/db')).toBe(true);
    expect(looksSecret('all good')).toBe(false);
  });
});
