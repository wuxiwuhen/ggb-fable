# 生成过程统一展示（方案 A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把思考流的展示形式推广到全部中间内容——生成中状态行常驻 + 叙述过程区滚动，结束后收成一行可展开的"查看过程"折叠行 + 最终结果气泡。

**Architecture:** 全部改动集中在 `components/ChatApp.tsx`（单文件大组件，沿用其现有模式：rAF 缓冲 + 平行 state + `thinkMsgId` 挂靠渲染）。流式叙述与气泡内容解耦：`streamBuf` 跨轮累加，flush 到新 state `narrText` 而非 `m.content`；turn 收尾时从 ref 快照 `process` 写入消息，由新增纯展示组件 `ProcessTail` 渲染结束后的折叠行。规格：`docs/superpowers/specs/2026-08-21-unified-process-display-design.md`。

**Tech Stack:** Next.js 15 + React 19（客户端组件，无新依赖）；vitest（仅回归，无组件测试基建，按规格不新增）。

## Global Constraints

- 提交身份必须：`git -c user.name=wuxiwuhen -c user.email=1527405202@qq.com commit`（yiduo/163 邮箱会被 Vercel 拒）。
- **禁止 push**：本地验证通过且用户明确允许后才可 push（push main 即生产部署）。
- Bash 每条命令先 `cd /Users/zhangyufen/claudecode/first_try/ggbfable/ggb-fable`（shell 会漂移到父目录）。
- 本机 `diff` 被劫持（对差异静默返回 0），文件比对一律 `git diff --no-index`。
- 样式复用现有类（`.thinking-block/.thinking-text/.ocr-toggle`），至多新增 1 条 `.process-label`；不引入新依赖、不新增组件测试基建（规格 YAGNI 节）。
- 验证命令：`npm run typecheck`、`npm run test`（现有 160 用例全绿即可，无新增单测——UI 渲染无基建，按规格以手动清单验收）。
- dev server 常驻 `localhost:3000`（日志 `/tmp/ggb-dev.log`），手动验证直接用。

---

### Task 1: 叙述流与气泡解耦（累加缓冲 + narrText + live 渲染 + 三收尾路径）

**Files:**
- Modify: `components/ChatApp.tsx`（Msg 接口 ~36-44、状态区 ~221-225、flushStream ~359-364、send 初始化 ~765-769、hooks.onRound ~851-856、成功收尾 ~890-893、错误收尾 ~932-941、finally ~942-953、assistant 渲染分支 ~1194-1220）
- 无新文件；无测试文件（手动验收，见 Step 11）

**Interfaces:**
- Produces: `Msg.process?: { thinking?: string; narrative?: string; thinkSecs?: number }`（Task 2 的 `ProcessTail` 消费）；`narrText` 组件内 state（Task 2 渲染复用）。

- [ ] **Step 1: Msg 接口加 process 字段**

`components/ChatApp.tsx` 的 `interface Msg`（~36-44）末尾（`ocr` 字段后）追加：

```ts
  // 生成过程快照(turn 结束时从 ref 一次性写入; 仅内存态不进 DB, 刷新后历史轮只显示最终气泡)
  process?: { thinking?: string; narrative?: string; thinkSecs?: number };
```

- [ ] **Step 2: 加 narrText state**

在思考流状态区（`const [thinkingText, setThinkingText] = useState('');` ~221 行附近）后加：

```ts
  const [narrText, setNarrText] = useState('');   // 流式叙述过程区文本(与 thinkingText 平行, 挂 thinkMsgId 消息)
```

- [ ] **Step 3: flushStream 改写 narrText（不再写 m.content）**

替换 `flushStream`（~359-364）：

```ts
  const flushStream = useCallback(() => {
    rafRef.current = null;
    const buf = streamBuf.current;
    if (!buf) return;
    setNarrText(buf.text);
  }, []);
```

- [ ] **Step 4: onRound 从清空改为轮间分隔**

替换 `hooks.onRound`（~851-856）：

```ts
          onRound: (_n, final) => {
            // 轮间分隔(累加制): 新一轮与上一轮叙述之间加空行, 过程区保留完整时间线;
            // 旧版每轮清空是"气泡文字跳变"的根因。final=true(轮数上限收尾)不加, 避免末尾悬空分隔。
            if (!final && streamBuf.current && streamBuf.current.text) { streamBuf.current.text += '\n\n'; scheduleFlush(); }
          },
```

- [ ] **Step 5: send() 初始化清 narrText**

初始化区（~765-769，`setThinkingText('')` 一带）加一行：

```ts
    setNarrText('');
```

- [ ] **Step 6: 收尾快照 helper + 成功路径写 process**

在 `const controller = new AbortController();`（~773）之后定义：

```ts
    // 过程快照: 收尾 setMessages 时读 ref——setState 异步, 读 narrText/thinkingText 会拿到未 flush 的旧值
    const snapshotProcess = () => ({
      thinking: thinkBufRef.current || undefined,
      narrative: streamBuf.current?.text || undefined,
      thinkSecs: thinkStartRef.current
        ? Math.max(1, Math.round((Date.now() - thinkStartRef.current) / 1000))
        : undefined,
    });
```

成功路径的 setMessages（~893）替换为：

```ts
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id
        ? { ...m, content: result.finalText, streaming: false, process: snapshotProcess() }
        : m)));
```

- [ ] **Step 7: 错误/中止路径改读累加叙述 + 写 process**

替换 catch 尾部的 setMessages（~932-941）：

```ts
      setMessages((prev) => {
        const cur = prev.find((m) => m.id === assistantMsg.id);
        const narr = streamBuf.current?.text || '';
        // 取消时若既无正文也无叙述, 直接移除空气泡(生成期 content 恒空, 叙述是唯一内容来源)
        if (aborted && cur && !cur.content.trim() && !narr.trim()) {
          return prev.filter((m) => m.id !== assistantMsg.id);
        }
        return prev.map((m) => (m.id === assistantMsg.id
          ? { ...m, streaming: false, content: m.content || narr || '（出错）', process: snapshotProcess() }
          : m));
      });
```

（`logTurnInterrupt` 三处调用不改代码——其 `finalText: streamBuf.current?.text` 因缓冲累加自动变为全程叙述，即规格决策 3。）

- [ ] **Step 8: finally 清 narrText**

finally 块（`setStage(null);` ~950 一带）加：

```ts
      setNarrText('');
```

- [ ] **Step 9: 渲染分支——状态行常驻 + 叙述过程区**

替换 assistant 分支（~1194-1220）中 `const preText = ...` 与末行三目。OCR 块与思考块**原样保留**（Task 1 不动思考块）：

```tsx
                const preText = m.streaming && !m.content.trim();   // ← 删除此行
```

末尾三目：

```tsx
                    {preText ? <AssistantProgress msg={m} trace={trace} stage={stage} /> : <MessageContent content={m.content || ''} />}
```

替换为：

```tsx
                    {m.streaming ? (
                      <>
                        <AssistantProgress msg={m} trace={trace} stage={stage} />
                        {m.id === thinkMsgId && narrText && (
                          <pre className="thinking-text">{narrText.slice(-2000)}</pre>
                        )}
                      </>
                    ) : (
                      <MessageContent content={m.content || ''} />
                    )}
```

- [ ] **Step 10: 机器验证**

```bash
npm run typecheck && npm run test
```

Expected: typecheck 0 错误；vitest 15 files / 160 tests 全过（回归）。

- [ ] **Step 11: 手动验证（dev server 已在 localhost:3000）**

思考模式选"思考·关"，发送：`画一个圆心在原点、半径为3的圆，并画出它的一条直径`。预期：
1. 生成中：状态行全程显示（读取画布/检索命令/构造图形…），下方暗色叙述区滚动累加，**正文不再直接进气泡**；
2. 结束：气泡第一次出现最终 markdown 结果；
3. 过程中无"文字被抹掉重写"的跳变。

（此任务后结束态仍显示旧版"已思考 Ns ▾"折叠——Task 2 接管，属预期中间态。）

- [ ] **Step 12: Commit**

```bash
git add components/ChatApp.tsx
git -c user.name=wuxiwuhen -c user.email=1527405202@qq.com commit -m "feat: 叙述流与气泡解耦——状态行常驻+叙述过程区, 收尾快照 process"
```

---

### Task 2: ProcessTail 折叠行 + 结束后渲染接管

**Files:**
- Modify: `components/ChatApp.tsx`（AssistantProgress 后加组件 ~113、assistant 渲染分支 ~1194-1220、thinkSecs 状态清理 ~224/768/947-948）
- Modify: `app/globals.css`（~130 `.thinking-text` 附近加 1 条）

**Interfaces:**
- Consumes: Task 1 的 `Msg.process`、`narrText`、`thinkMsgId`/`thinkingText`/`thinkOpen` 既有机制。
- Produces: `ProcessTail({ process }: { process: NonNullable<Msg['process']> })` 纯展示组件（内部 `open` 局部 state，默认 false）。

- [ ] **Step 1: 加 .process-label 样式**

`app/globals.css` 在 `.thinking-text`（~129）之后加：

```css
.process-label { font-size: 12px; color: #9ca3af; margin: 6px 0 0; }
```

- [ ] **Step 2: 加 ProcessTail 组件**

`components/ChatApp.tsx` 中 `AssistantProgress` 组件（~71-113）之后、`fallbackCopy` 之前加：

```tsx
// 结束后的过程折叠行: 一行汇总(已思考 Ns · 查看过程), 展开显示思考过程 + 执行叙述两段。
// 数据来自 turn 收尾的 process 快照(内存态), 刷新后消失——历史轮只剩最终气泡(与旧思考流行为一致)。
function ProcessTail({ process }: { process: NonNullable<Msg['process']> }) {
  const [open, setOpen] = useState(false);
  const arrow = open ? '▲' : '▾';
  const head = process.thinkSecs ? `已思考 ${process.thinkSecs}s · 查看过程 ${arrow}` : `查看过程 ${arrow}`;
  return (
    <div className="thinking-block">
      <button type="button" className="ocr-toggle" onClick={() => setOpen((v) => !v)}>{head}</button>
      {open && (
        <>
          {process.thinking && (
            <>
              <div className="process-label">思考过程</div>
              <pre className="thinking-text">{process.thinking.slice(-2000)}</pre>
            </>
          )}
          {process.narrative && (
            <>
              <div className="process-label">执行叙述</div>
              <pre className="thinking-text">{process.narrative.slice(-2000)}</pre>
            </>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 思考块改为仅生成期渲染（结束后由 ProcessTail 接管）**

渲染分支中思考块（~1208-1217）的门从 `m.id === thinkMsgId && thinkingText` 改为 `m.streaming && m.id === thinkMsgId && thinkingText`，按钮文案删掉结束态分支：

```tsx
                    {m.streaming && m.id === thinkMsgId && thinkingText && (
                      <div className="thinking-block">
                        <button type="button" className="ocr-toggle" onClick={() => setThinkOpen((v) => !v)}>
                          {`思考中…（点击${thinkOpen ? '收起' : '展开'}）`}
                        </button>
                        {thinkOpen && <pre className="thinking-text">{thinkingText.slice(-2000)}</pre>}
                      </div>
                    )}
```

- [ ] **Step 4: 非流式分支挂 ProcessTail**

Task 1 改过的三目中，非流式分支：

```tsx
                    ) : (
                      <MessageContent content={m.content || ''} />
                    )}
```

改为：

```tsx
                    ) : (
                      <>
                        {m.process && <ProcessTail process={m.process} />}
                        <MessageContent content={m.content || ''} />
                      </>
                    )}
```

- [ ] **Step 5: 删除 thinkSecs state（信息已进 process）**

三处清理：
1. 删 `const [thinkSecs, setThinkSecs] = useState<number | null>(null);`（~224）；
2. 删 send 初始化里的 `setThinkSecs(null);`（~768）；
3. 删 finally 里的 `if (thinkStartRef.current != null) setThinkSecs(Math.max(1, Math.round((Date.now() - thinkStartRef.current) / 1000)));`（~948；快照计算已由 Task 1 的 `snapshotProcess` 承担）。

删完 `grep -n thinkSecs components/ChatApp.tsx` 应只剩两处：`snapshotProcess` 内的字段计算与 `ProcessTail` 内的 `process.thinkSecs` 读取。

- [ ] **Step 6: 机器验证**

```bash
npm run typecheck && npm run test
```

Expected: typecheck 0 错误（thinkSecs 无残留引用）；vitest 160 全过。

- [ ] **Step 7: 手动验证（覆盖规格清单 1/2/4/5）**

1. 思考·关 + 简单题：生成中 = 状态行 + 叙述区；结束 = 一行"查看过程 ▾" + 最终气泡；点开显示"执行叙述"段。
2. 思考·自动 + 抛物线综合题（`画抛物线 y = x²-4x+3, 标出对称轴、顶点、与 x 轴交点`）：生成中 = 思考块 + 状态行（解题中→执行第 N 步）+ 叙述区三层；结束 = "已思考 Ns · 查看过程 ▾"，展开两段齐全。
3. 生成中点"停止"（叙述已有文本）：气泡保留，content=累加叙述，折叠行存在；再试发送后立即停止（无文本）：空气泡被移除。上游报错路径：设置页把 BYOK key 临时改错一位再发送——气泡落"（出错）"（或叙述文本）+ error banner + 折叠行；验完改回。
4. 完成一轮后刷新页面/切走再切回：历史轮只有最终气泡，无折叠行、无思考块。
5. 上传题目图片发送：OCR 识别块仍在气泡最上方。

- [ ] **Step 8: Commit**

```bash
git add components/ChatApp.tsx app/globals.css
git -c user.name=wuxiwuhen -c user.email=1527405202@qq.com commit -m "feat: ProcessTail 结束后过程折叠行, 思考块收归生成期"
```

---

## 完成后

- 汇报两个 commit + 手动清单结果给用户，**等用户本地实测通过并明确允许后才 push**。
- 规格中的"不做的事"（过程不落 DB、无自动滚动逻辑、不合并单容器）即为边界，勿越界实现。
