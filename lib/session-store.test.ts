import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore, type SessionMeta } from './session-store';

const meta = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  id, title: null, mode: 'trial', model: null, pinned: false,
  created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z', ...over,
});

describe('mergeSessions', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], currentSessionId: null, loadState: 'ready' });
  });

  it('本地新会话(服务端快照还没有)不被服务端列表冲掉', () => {
    // 复现场景: 惰性建会话先 upsert 进本地, 晚到的服务端快照不含它 → 旧 setSessions 会把它丢掉
    useSessionStore.getState().upsert(meta('local-a', { title: '本地新会话' }));
    useSessionStore.getState().mergeSessions([meta('srv-1', { title: '历史会话' })]);
    const ids = useSessionStore.getState().sessions.map((s) => s.id).sort();
    expect(ids).toEqual(['local-a', 'srv-1']);
  });

  it('同 id 以服务端为权威覆盖本地旧值', () => {
    useSessionStore.getState().upsert(meta('s1', { title: null, updated_at: '2026-09-05T00:00:00Z' }));
    useSessionStore.getState().mergeSessions([meta('s1', { title: '服务端标题', updated_at: '2026-09-05T09:00:00Z' })]);
    const s1 = useSessionStore.getState().sessions.find((s) => s.id === 's1');
    expect(s1?.title).toBe('服务端标题');
    expect(s1?.updated_at).toBe('2026-09-05T09:00:00Z');
    expect(useSessionStore.getState().sessions).toHaveLength(1); // 无重复
  });

  it('多次 merge 幂等, 不产生重复条目', () => {
    useSessionStore.getState().mergeSessions([meta('a'), meta('b')]);
    useSessionStore.getState().mergeSessions([meta('b'), meta('c')]);
    const ids = useSessionStore.getState().sessions.map((s) => s.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});
