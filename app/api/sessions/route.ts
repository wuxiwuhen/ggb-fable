// 会话持久化(替代本地 log/jsonl) + 迭代数据收集
// 所有写入用 service_role(绕过 RLS), 读自己走 RLS
//
// POST 多用途(body.action):
//   create  { action, mode, model?, title? }              → 新建会话, 返回 { id }
//   append  { action, sessionId, events: [...] }          → 追加事件为 messages 行(会话不存在自动建)
//   update  { action, id, title?, pinned? }                → 改标题/置顶
//   delete  { action, id }                                 → 删除会话(联级删 messages)
// GET:
//   (无参)            → 当前用户会话列表(倒序)
//   ?id=UUID          → 单会话全部 messages(按 id 升序)
//
// events → messages 映射: user_input→user, turn_end→assistant, tool_call→tool(含 args/result),
//           其余(llm_request/response/ggb_exec/error/session_start)也存, 用于迭代分析

import { getUserFromCookie, getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'edge';

export async function GET(req: Request) {
  const user = await getUserFromCookie(req);
  if (!user) return json(401, { error: '未登录' });
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const admin = getSupabaseAdmin();

  if (id) {
    // session + messages 并行查询(省一次跨区往返, 之前是串行 2 次)
    const [sessRes, msgsRes] = await Promise.all([
      admin.from('sessions').select('*').eq('id', id).maybeSingle(),
      admin.from('messages').select('*').eq('session_id', id).order('id', { ascending: true }),
    ]);
    const sess = sessRes.data;
    if (!sess || sess.user_id !== user.id) return json(404, { error: '会话不存在' });
    return json(200, { session: sess, messages: msgsRes.data || [] });
  }

  const { data } = await admin
    .from('sessions')
    .select('id, title, mode, model, pinned, created_at, updated_at')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false });
  return json(200, { sessions: data || [] });
}

export async function POST(req: Request) {
  const user = await getUserFromCookie(req);
  if (!user) return json(401, { error: '未登录' });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: '请求体解析失败' }); }
  const admin = getSupabaseAdmin();

  if (body.action === 'create') {
    const { data } = await admin.from('sessions').insert({
      user_id: user.id, mode: body.mode || 'trial', model: body.model || null, title: body.title || null,
    }).select('id').single();
    return json(200, { id: data?.id });
  }

  if (body.action === 'update') {
    const patch: any = { updated_at: new Date().toISOString() };
    if (body.title != null) patch.title = body.title;
    if (body.canvas_xml !== undefined) patch.canvas_xml = body.canvas_xml;   // 画布 XML 快照持久化
    if (body.pinned !== undefined) patch.pinned = body.pinned;              // 置顶切换
    if (body.perspective !== undefined) patch.perspective = body.perspective; // 视角(2D/3D)
    const { data: rows } = await admin.from('sessions')
      .update(patch).eq('id', body.id).eq('user_id', user.id).select('id');
    return json(200, { ok: true, affected: rows?.length ?? 0 });
  }

  if (body.action === 'delete') {
    // 鉴权归属后删; messages 有 ON DELETE CASCADE, 自动联级删
    const { data: existing } = await admin.from('sessions').select('id, user_id').eq('id', body.id).maybeSingle();
    if (!existing || existing.user_id !== user.id) return json(404, { error: '会话不存在' });
    await admin.from('sessions').delete().eq('id', body.id);
    return json(200, { ok: true });
  }

  if (body.action === 'append') {
    const events: any[] = body.events || [];
    if (!events.length) return json(200, { ok: true, n: 0 });

    // 确保 session 存在(不存在则建; 校验归属)
    let sessionId: string = body.sessionId;
    if (sessionId) {
      const { data: existing } = await admin.from('sessions').select('id, user_id').eq('id', sessionId).maybeSingle();
      if (existing && existing.user_id !== user.id) return json(403, { error: '无权操作' });
      if (!existing) {
        await admin.from('sessions').insert({ id: sessionId, user_id: user.id, mode: body.mode || 'trial' });
      }
    } else {
      const { data: created } = await admin.from('sessions').insert({ user_id: user.id, mode: body.mode || 'trial' }).select('id').single();
      sessionId = created?.id;
    }

    // events → messages 行
    const rows = events.map((ev) => eventToRow(sessionId, user.id, ev));
    if (rows.length) {
      await admin.from('messages').insert(rows);
    }
    // 更新会话 updated_at
    await admin.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId);
    return json(200, { ok: true, n: rows.length, sessionId });
  }

  return json(400, { error: '未知 action' });
}

// 单事件 → messages 行
function eventToRow(sessionId: string, userId: string, ev: any) {
  const base: any = {
    session_id: sessionId,
    user_id: userId,
    created_at: new Date(ev.ts || Date.now()).toISOString(),
  };
  switch (ev.type) {
    case 'user_input':
      return { ...base, role: 'user', content: ev.text || '', round: null };
    case 'turn_end':
      return { ...base, role: 'assistant', content: ev.finalText || '', round: null };
    case 'tool_call':
      return {
        ...base, role: 'tool', tool_name: ev.name, tool_args: ev.args,
        tool_result: ev.result, round: ev.round, content: null,
      };
    default:
      // llm_request/llm_response/ggb_exec/error/session_start —— 存为 system, content 为 JSON 摘要(迭代分析用)
      return { ...base, role: 'system', tool_name: ev.type, tool_args: null, tool_result: ev, round: ev.round || null, content: JSON.stringify(ev).slice(0, 8000) };
  }
}

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
