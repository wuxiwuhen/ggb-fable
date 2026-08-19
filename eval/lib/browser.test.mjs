import { describe, it, expect } from 'vitest';
import { buildByokPayload } from './browser.mjs';

const variant = {
  llm: { api_key: 'k', base_url: 'https://x/v1', model_name: 'm' },
  vision: { api_key: 'k', base_url: 'https://x/v1', model_name: 'v' },
  embedding: { api_key: 'k', base_url: 'https://x/v1', model_name: 'e' },
};

describe('buildByokPayload — thinking_mode 注入', () => {
  it('variant 带 thinking_mode → 写入 profile(引擎经 Task 4 管道消费)', () => {
    const p = buildByokPayload({ variant: { ...variant, thinking_mode: 'never' }, temperature: 0.2, maxToolRounds: 30 });
    expect(p.state.byokProfiles[0].thinking_mode).toBe('never');
  });
  it('缺省 → auto', () => {
    const p = buildByokPayload({ variant, temperature: 0.2, maxToolRounds: 30 });
    expect(p.state.byokProfiles[0].thinking_mode).toBe('auto');
  });
});
