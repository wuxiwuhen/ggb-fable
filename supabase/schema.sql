-- ──────────────────────────────────────────────────────────────
-- GGB Fable · Supabase schema
-- 在 Supabase 控制台 → SQL Editor 里整段执行
-- ──────────────────────────────────────────────────────────────

-- ── 1. profiles: 用户档案, 标记管理员 ──
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  is_admin boolean default false,
  created_at timestamptz default now()
);

-- ── 2. usage: 试用额度计数 ──
-- used = 已用次数; trial_limit = 额度上限(管理员可改, 默认 5)
create table if not exists public.usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  used integer default 0 not null,
  trial_limit integer default 5 not null,
  updated_at timestamptz default now()
);

-- ── 3. sessions: 会话(云端持久化 + 迭代数据收集, 替代 log/jsonl) ──
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  mode text not null,                    -- 'trial' | 'byok'
  title text,
  model text,                            -- 用了哪个模型(trial) 或 BYOK 的 model_name
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── 4. messages: 单会话的消息流(对话 + 工具轨迹) ──
create table if not exists public.messages (
  id bigint primary key generated always as identity,
  session_id uuid references public.sessions(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,  -- 冗余, 便于 RLS
  role text not null,                     -- 'user' | 'assistant' | 'system' | 'tool'
  content text,
  tool_name text,                         -- role=tool 时记录工具名
  tool_args jsonb,                        -- 工具参数
  tool_result jsonb,                      -- 工具结果
  round integer,                          -- Agent 第几轮
  created_at timestamptz default now()
);

create index if not exists idx_messages_session on public.messages(session_id, id);
create index if not exists idx_sessions_user on public.sessions(user_id, updated_at desc);

-- ──────────────────────────────────────────────────────────────
-- 触发器: 新用户注册时自动建 profiles + usage 行
-- ──────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  admin_emails text[] := string_to_array(current_setting('app.admin_emails', true), ',');
  is_admin_user boolean := false;
  trial_default int := coalesce(nullif(current_setting('app.trial_default_limit', true), '')::int, 5);
begin
  -- 判断是否管理员(邮箱在 ADMIN_EMAILS 里)
  if new.email is not null and admin_emails is not null then
    select exists(select 1 from unnest(admin_emails) e where trim(e) = new.email) into is_admin_user;
  end if;

  insert into public.profiles (user_id, email, is_admin)
  values (new.id, new.email, is_admin_user)
  on conflict (user_id) do nothing;

  insert into public.usage (user_id, used, trial_limit)
  values (new.id, 0, trial_default)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- 删除旧触发器(若存在)再建, 保证可重复执行
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ──────────────────────────────────────────────────────────────
-- Row Level Security
-- ──────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.usage enable row level security;
alter table public.sessions enable row level security;
alter table public.messages enable row level security;

-- 管理员判定函数(security definer, 以定义者权限绕过 RLS 查 profiles,
-- 避免 policy 里直接 exists(profiles) 造成无限递归错误 42P17)
create or replace function public.is_current_user_admin()
returns boolean
language sql security definer set search_path = public
as $$
  select exists(select 1 from public.profiles p where p.user_id = auth.uid() and p.is_admin);
$$;

-- profiles: 用户读自己; 管理员读全部
drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin" on public.profiles
  for select using (auth.uid() = user_id or public.is_current_user_admin());

-- usage: 用户只能读自己(扣减走 service_role, 不让前端自己改)
drop policy if exists "usage_select_self_or_admin" on public.usage;
create policy "usage_select_self_or_admin" on public.usage
  for select using (auth.uid() = user_id or public.is_current_user_admin());

-- sessions: 用户增/读/改自己的; 管理员读全部
drop policy if exists "sessions_owner_all" on public.sessions;
create policy "sessions_owner_all" on public.sessions
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "sessions_admin_read" on public.sessions;
create policy "sessions_admin_read" on public.sessions
  for select using (public.is_current_user_admin());

-- messages: 用户增/读自己的; 管理员读全部
drop policy if exists "messages_owner_all" on public.messages;
create policy "messages_owner_all" on public.messages
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "messages_admin_read" on public.messages;
create policy "messages_admin_read" on public.messages
  for select using (public.is_current_user_admin());

-- ── 原子扣减(免费模式核心): 仅当 used < trial_limit 时 used+1, 返回新状态; 否则返回空 → 402 ──
-- 用 service_role 调用。RETURNING 保证扣减成功才继续(防并发超扣)
create or replace function public.deduct_usage(target_user uuid)
returns table(used int, trial_limit int)
language sql
security definer set search_path = public
as $$
  update public.usage
  set used = used + 1, updated_at = now()
  where user_id = target_user and used < trial_limit
  returning used, trial_limit;
$$;

-- ──────────────────────────────────────────────────────────────
-- 管理员操作(用 service_role key 在后端调用, 绕过 RLS)
--   - refresh_usage(user_id): 重置 used=0
--   - set_usage_limit(user_id, limit): 设置额度
-- ──────────────────────────────────────────────────────────────
create or replace function public.refresh_usage(target_user uuid)
returns void
language sql
security definer set search_path = public
as $$
  update public.usage set used = 0, updated_at = now() where user_id = target_user;
$$;

create or replace function public.set_usage_limit(target_user uuid, new_limit int)
returns void
language sql
security definer set search_path = public
as $$
  update public.usage set trial_limit = new_limit, updated_at = now() where user_id = target_user;
$$;
