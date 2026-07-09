# GGB Fable 部署指南

免费试用(邮箱注册 ≤5 次) + BYOK(自带 Key) 的 GeoGebra AI 画布助手。
栈: Next.js 15 + Supabase + Vercel。

---

## 0. 安全前置(先做!)

`ggb_fable/models.local.json` 里有**真实**的 DeepSeek / GLM API key。
若旧 demo 已推过 GitHub, 这些 key 可能已泄露 —— **立即去厂商控制台撤销轮换**:
- DeepSeek: https://platform.deepseek.com → API Keys
- 智谱 GLM: https://open.bigmodel.cn → API Keys

新仓库已把 `models.local.json` / `.env.local` 加入 `.gitignore`, 改用环境变量。

---

## 1. Supabase 配置

1. https://supabase.com 新建项目
2. **Authentication → Providers → Email**: 开启
   - 若想注册即用(不发确认邮件): 关闭 "Confirm email"
   - 若要邮箱验证: 保持开启(Magic Link 登录会自动处理)
3. **Authentication → URL Configuration**: 把 Site URL 设为你的 Vercel 域名, Redirect URLs 加上
   `https://<你的域名>/api/auth/callback` 和 `http://localhost:3000/api/auth/callback`
4. **SQL Editor**: 整段执行 `supabase/schema.sql`(建表 + RLS + 扣减/管理员 RPC)
5. 记下 **Project URL**、**anon key**、**service_role key**(Settings → API)
6. 把你的邮箱设为管理员: SQL Editor 执行(把邮箱换成你的)
   ```sql
   update profiles set is_admin = true where email = 'you@example.com';
   -- 或还没注册时, 先注册一个账号再执行上面这句
   ```
   (也可在 `.env.local` 的 `ADMIN_EMAILS` 填邮箱, 新注册时自动设管理员)

---

## 2. 本地 .env.local

复制 `.env.local.example` 为 `.env.local`, 填入:
- `DEEPSEEK_API_KEY` / `GLM_API_KEY` —— 你的(轮换后的)key, 免费模式注入用
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` —— Supabase
- `SUPABASE_SERVICE_ROLE_KEY` —— Supabase(service_role, 仅后端)
- `ADMIN_EMAILS` —— 你的邮箱
- (可选)`TRIAL_TOKEN_SECRET` —— `openssl rand -hex 32` 生成

---

## 3. 本地运行

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

首次访问跳转 `/login`, 输邮箱收 Magic Link 登录。

---

## 4. 部署到 Vercel

1. 把本目录推到 GitHub(注意确认 `models.local.json` / `.env.local` 未被提交)
2. https://vercel.com → New Project → 导入该仓库
3. **Settings → Environment Variables**: 把 `.env.local` 里所有变量配进去
   (`NEXT_PUBLIC_*` 会暴露到前端, anon key 是安全的; service_role / API key 不要带 `NEXT_PUBLIC_` 前缀)
4. Deploy。Vercel 自动识别 Next.js, Edge runtime 的 API route 自动生效。

---

## 5. 验证清单

部署后自测:
- [ ] `/login` 邮箱收到 Magic Link, 点击后登录成功
- [ ] 免费试用模式: 顶栏显示"剩余 5/5", 发送一条需求能生成画布
- [ ] 发送后剩余次数 -1, 同一需求的多轮工具调用只扣 1 次(trial_token 生效)
- [ ] 用完 5 次后提示"试用次数已用完"
- [ ] 切换"自带 Key"模式: 设置页填自己的 key 后能正常生成(不计额度)
- [ ] 管理员: 访问 `/admin` 能看到用户列表, 能刷新/设置某用户额度
- [ ] 会话云端持久化: `/api/sessions` 写入成功(迭代数据收集)

---

## 架构要点

| 模式 | Key 来源 | 请求路径 | 计费 |
|---|---|---|---|
| 免费试用 | 你的(后端注入) | `/api/trial/llm` 代理 | 每次发送扣 1, 单意图多轮复用 trial_token 免扣 |
| 自带 Key | 用户(localStorage) | 前端直连厂商 | 不计额度 |

**防失控软上限**(物理硬上限靠 API 充值额度): 单意图最多 30 轮工具调用 / 100k 输入 token。
**OCR 不计 5 次额度**(试用次数 = 画布生成次数), 由登录 + 充值额度兜底。
