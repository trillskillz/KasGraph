import { describe, expect, it } from 'vitest';
import { sanitizeLogLine, sanitizeLogText } from '../scripts/soak/sanitize-logs.js';

describe('soak log sanitizer', () => {
  it('redacts database URLs, bearer tokens, and env-style secrets', () => {
    const input =
      'DATABASE_URL=postgres://user:pass@127.0.0.1:5432/kasgraph Authorization: Bearer abc.def.ghi KASGRAPH_DEPLOY_TOKEN=secret';
    const out = sanitizeLogLine(input);

    expect(out).toContain('DATABASE_URL=[REDACTED]');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).toContain('KASGRAPH_DEPLOY_TOKEN=[REDACTED]');
    expect(out).not.toContain('postgres://user');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('secret');
  });

  it('redacts private-looking RPC URLs, IPs, credentials, and local paths', () => {
    const input =
      'rpc=wss://rpc.example.com/ws?api_key=abc ip=192.168.1.10 path=/home/void/openclaw/workspace2/KasGraph password=hunter2';
    const out = sanitizeLogLine(input);

    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('api_key=abc');
    expect(out).not.toContain('192.168.1.10');
    expect(out).not.toContain('/home/void');
    expect(out).not.toContain('hunter2');
  });

  it('sanitizes multiline logs without dropping line structure', () => {
    const out = sanitizeLogText('ok\nAPI_KEY=abc123\nready');
    expect(out).toBe('ok\nAPI_KEY=[REDACTED]\nready');
  });
});
