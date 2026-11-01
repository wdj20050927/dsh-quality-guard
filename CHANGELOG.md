# 更新日志

## v1.1.0 — 2026-11-01

照 Anthropic 官方 [`anthropics/claude-cookbooks` 的 `capabilities/content_moderation`](https://github.com/anthropics/claude-cookbooks/tree/main/capabilities/content_moderation) 重做判官链路。核心变化一句话：**判官的分数只要吐出来了就必须被用上；吐不出来时不再假装它说了「通过」。**

### 引擎 `engine/index.mjs`

- **输出格式从 JSON 改成行式，分数第一行**（`SCORE: / VERDICT: / WORST: / FIX:`）。理由：截断只吃掉尾巴，吃不掉第一行。旧格式下 `{"score": 42, "verdict": "fa` 这种半截 JSON 会整条作废。
- **`parseVerdict` 分四层抢救**（`scoreSource` 字段记录走了哪层）：
  1. `lines` —— 行式 `SCORE:`（主路径）；
  2. `json` —— 完整 JSON（判官习惯性吐 JSON 时也认）；
  3. `salvage` —— 正则抠 `"score": 42`，**专救被截断在半路的 JSON**；
  4. `verdict-only` —— 只写了 `VERDICT: fail` 没给数字，照样按不合格判（「宁可判不合格」）。
  四层都拿不到才抛 `judge returned no score`。
- **先解析、再判失败**：`runJudge` 不再一看到 `finish === 'error'` / `'aborted'` 就抛错，而是先尝试从已收到的文本里抢救分数。旧版顺序反了，导致「分数已经吐出来才断流」的判官输出被整条丢弃。
- **补判一次**：第一次拿不到裁定就换更便宜的提示（只要一行 `SCORE:`，问题截 800 字、回复截 2500 字）再问一次，专救「理由写太长把 token 写光」。
- **三值裁定 + Unknown 出口**：新增配置 `onUnknown`（`'pass'` 默认 / `'rework'`）。两次都拿不到裁定时审计记 `decision: "unknown"` + 原因；`onUnknown=rework` 时打回重写而不是静默放行。
- **分数与 verdict 不再互相打架**：明确 `verdict=fail` 就回炉（哪怕分数高）；分数低于阈值也回炉（哪怕 `verdict=pass`）。
- **审计新增字段**：`decision`（`pass` / `fail` / `unknown`）、`verdict`、`scoreSource`、`retried`、`onUnknown`。unknown 行也带 `error` 与诊断字段，不再是一句空话。

### 回归集 `engine/fixtures/audit-regressions.json`

- 从生产 `audit.jsonl` 导出全部 11 条 `judge returned no JSON` 原始判官输出（5 条带分数：42 / 55 / 55 / 90 / 58；6 条真空输出）。selftest 直接拿它们当夹具跑——**这是照着 Anthropic「评产出、按真实失败样本起步」那条做的**。
- 同一套回归集跑 v1.0.1 的引擎：**4 条与预期相反**（42 / 55 / 55 / 58 全部本应打回却放行）；跑 v1.1.0：全部按分数正确裁定。

### 面板 `panel/`

- 新增「判官拿不到裁定时」二选一行（放行 / 打回重写），读写 `settings.onUnknown`。
- `settings.js` 的 `defaults()` / `normalize()` / `FIELD_HELP` 与 `client.js` 的 `HELP` 同步；非法值退回默认而不是报错（面板不能因为一个字段把设置写坏）。

### 测试

- `node engine/selftest.mjs` → **100 passed, 0 failed**（v1.0.1 是 43）：新增行式解析、半截 JSON 抢救、断流但有分数、补判成功、unknown 出口、`onUnknown=rework`、verdict 与分数冲突、`verdict-only`、真实回归集 11 条等用例。

### 已知限制

- `onUnknown` 默认仍是 `'pass'`（与旧行为一致，避免一升级就满屏打回）。要宁严不宽请自己改成 `'rework'`。
- 判官模型本身的能力没变：拿不到分数时最多补判一次，两次都空仍然只能走 unknown 出口。
- 没有真模型的端到端验证：所有测试都是离线假 llm，真路由下的行为只靠审计事后看。

## v1.0.1 — 2026-11-01

修掉「判官一个字都没吐，却被静默放行」这个坑：审计里原先只剩一句 `judge returned no JSON: `，分不清是超时被 abort 还是 token 被推理吃光。

### 引擎 `engine/index.mjs`

- **收 `reasoning-delta`**：文本通道为空时，从推理文本里捞一次 JSON 再判（有模型把该说的话全放在 reasoning 里）。
- **`finish.kind === 'aborted'` 当显式超时**：超时 abort 在 SDK 里报的是 `aborted` 而不是 `error`，原先只认 `error`，于是被当成「空文本」静默 fail-open。现在抛 `judge aborted after <ms>ms (timeoutMs=…)`。
- **空产出有话说**：文本与推理都空时报 `judge produced no text (finish=…, <ms>ms, reasonChars=…, maxTokens=…)`。
- **审计补诊断字段**：`finish`（`stop` / `max-tokens` / `aborted` / `error` / `none`）、`judgeMs`、`textChars`、`reasonChars`、`textSource`（`text` / `reasoning`）；异常路径也带上这几个字段（挂在 error 上写进同一行）。
- **兜底默认提高**：`timeoutMs 20000 → 60000`、`maxTokens 1500 → 4000`（面板上限仍是 120000 / 8000）。

### 面板 `panel/`

- 默认值同步为 `judge.timeoutMs 60000`、`judge.maxTokens 4000`。

### 测试

- `node engine/selftest.mjs` → **43 passed, 0 failed**（v1.0.0 是 30）：新增「JSON 全在 reasoning 通道也能判」「`aborted` 不回炉且审计记下 finish/耗时」「`max-tokens` 空产出报错」「正常判分记诊断字段」四组。

### 已知限制

- 判官仍是 fail-open：拿不到裁定（超时/空产出/报错）就放行，只是现在审计里能看清失败原因。

## v1.0.0 — 2026-11-01

首个版本：发消息前质检（引擎 `selfcheck-guard` + 面板 `dsh-quality-guard`）。

### 引擎 `engine/index.mjs`

- 挂载点 `agent/turn-stopping`：轮次将结束时投入一条 next-step，把回复交给判官；不合格则 `agent.steer()` 打回重写。
- 判官是独立的一次模型调用（`llm` 服务 + 当前会话路由，可用 `judge.model` 覆盖）。
- 判据两个来源：`criteriaFile` 文本原样喂给判官，或 `settings.json` 的 `criteria` 数组（`{id,label,enabled,text}` + `exceptions` 拼装）；全空退回代码内置判据。
- 每次判决前重新 `stat` 读 `settings.json`，缓存 key 为 `mtimeMs:size` —— 面板改完下一轮即时生效，不需要热重载。
- 字段夹取：`maxReworks 0–10`、`minReplyChars 0–20000`、`scoreThreshold 0–100`、`timeoutMs 1000–120000`、`maxTokens 64–8000`。
- 审计日志 `audit.jsonl` 每行记 `turn/session/score/failed/worst/fix/rework/dryRun/route/chars`。
- 默认兜底：`enabled true`、`dryRun true`、`maxReworks 3`、`timeoutMs 20000`、`maxTokens 1500`、`minReplyChars 0`、`scoreThreshold 70`。

### 面板 `panel/`

- Web 面板：侧边栏一项「质检」+ 主栏一页编辑器，读写 `~/.dsh/quality-guard/settings.json`。
- 判据逐条开关、例外文本框、字段说明（`FIELD_HELP`）、输入校验（判据 ≤40 条、`text` ≤2000 字符、例外 ≤4000 字符、至少保留一条启用判据）。
- 保存前自动备份到 `settings.json.bak`。

### 测试

- `node engine/selftest.mjs` → **30 passed, 0 failed**：用假 llm，不联网不花钱，覆盖判据拼装、超时/报错放行、`maxReworks` 上限、`dryRun`、外部判据文件、活设置覆盖 patch 等。

### 设计取舍（不是 bug）

- **打回时界面会多留一条旧回复**：旧回复已按 `surfaceOp: "append"` 落盘，界面只收 append。取舍是能对照看长/短两版；要只留最后版得改挂 `llm/stream` 攒完整条再判，代价是流式体感。
- **一切失败都放行（fail-open）**：判官超时、报错、拿不到 llm、没有路由、`settings.json` 读坏——全部跳过检查继续会话，质检绝不卡住会话。
- **`judge.maxTokens` 别调回 800**：判官输出 JSON 会被截断，表现为日志里 `judge returned no JSON`，随后整条 fail-open 放行（看着没报错，其实压根没判）。
- 同一 `turn` 的打回计数在内存里按 `session:turn` 分桶，进程重启清零。

### 已知限制

- 实测环境：DeepSeek Harness 桌面版 `0.2.1-rc.5`、Windows、Node `24.21.0`；macOS / Linux 路径分支未实测。
- 引擎零依赖（仅 Node 内置模块）；面板依赖 `react ^18.2` 与 dsh 自带的 `dsh-client-locale`、`dsh-client-ui-layout`。
- 面板在 Windows 上靠目录联接（`mklink /J`）进 profile 的 `node_modules`。
