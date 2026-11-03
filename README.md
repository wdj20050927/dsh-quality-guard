# dsh-quality-guard

**发消息之前，先让另一个模型读一遍。**

助手的回复在真正发给你之前，会被第二个模型当裁判判一次；不合判据就打回重写。
这是 DeepSeek Harness（dsh）的一个插件组合：`engine/`（钩子本体）+ `panel/`（可视化面板，可选）。

> 一句话版本：机械判据（字数、正则、格式）管不住的偏题、铺垫、术语堆砌，只能靠**语义判定**。

---

## 为什么要第二个模型

第一版用的是机械判据：字数 ≤800、出现数值必须有锚点。结果很难看——一段完全答非所问的回复，只要够短、带个链接，就合规了。

真正的需求是「用最直白的话，把最核心的那个因素放在最前面」，这条没有正则能表达：它要读语义，还要对照原问题看有没有答偏。

所以判据交给第二个模型。依据是：**同一条上下文里的自检基本无效**（Huang et al., *Large Language Models Cannot Self-Correct Reasoning Yet*, arXiv:2310.01798），而独立轮次的验证才真的有效（CoVe, arXiv:2309.11495）。代价是每轮多一次模型调用——如果你觉得认知带宽比 token 贵，这笔买卖就划算。

---

## 两半分别是什么

| 目录 | 角色 | 干什么 |
| --- | --- | --- |
| `engine/` | selfcheck-guard | 挂在 `agent/turn-stopping` 上。轮次要结束时往 next-step 投一条消息，轮次就不结束，模型接着改；判官是另起的一次模型调用。 |
| `panel/` | dsh-quality-guard | Web 面板：侧边栏一行「质检」+ 主栏一页编辑器。读写 `~/.dsh/quality-guard/settings.json`。 |

**「面板改完即时生效」不靠热重载**：引擎在每次判决前重新 `stat` + 读一遍 `settings.json`（用 `mtime:size` 做缓存 key），文件一变，下一轮就用新值。

---

## 一次检查是怎么走的

```mermaid
sequenceDiagram
    participant U as 用户
    participant A as 助手
    participant E as engine
    participant J as 判官（第二次模型调用）
    U->>A: 提问
    A->>E: 轮次将结束（agent/turn-stopping）
    E->>E: 读 settings.json（mtime:size 缓存 key）
    E->>J: 判据 + 原问题 + 草稿
    J-->>E: 1:8 2:10 3:6 …（逐条 0-10 打分压在第一行）+ FIX
    E->>E: 折算成 0-100（分母恒为「条数×10」，漏答按 0 压着；第 1 条 <6 → 上限 59）
    alt 不及格 且 reworks < maxReworks
        E->>A: steer：按 fix 重写
        A->>E: 轮次再次将结束
    else 及格 / 到上限 / 判官两次都没给裁定（unknown 出口）
        E-->>U: 放行（onUnknown=rework 时打回）
    end
```

判官拿不到 llm、超时、报错、没有路由——仍然走放行分支（fail-open）。但**判官已经吐出来的分数不会被丢掉**：断流、`max-tokens`、半截 JSON 都先抢救分数，拿不到分数才补判一次，两次都空才进 unknown 出口。

v1.4.0 起判官走**逐条 0-10 打分**：判据里只要有 ≥2 条编号条目，每条判据各拿一个 0-10 的分，总分由程序换算。为什么不是 yes/no、也不是让判官直接给 0-100，见[为什么不逐条 yes/no，也不直接打分](#为什么不逐条-yesno也不直接打分)。

**及格与否只看折算出来的分数**（v1.2.1 起）：折算分低于 `triggers.scoreThreshold` 才打回，不是「有哪一条分低就打回」。例外是第 1 条——它低于 6 分时满分被压到 59，必然低于及格线，相当于硬门槛。这么定是因为实测过：判据表里放「保持某某人设」这类风格项时，普通回复永远不满足，若按「任一条不过即 fail」，一条 80 分的回复照样被打回，及格线就形同虚设了。

## 安装

### 1. 引擎（必须）

```bash
# 把 engine/ 整个拷到插件目录
~/.dsh/plugins/selfcheck-guard/
```

然后在你的 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾追加一段 `insert`，把路径换成你自己的绝对路径（Windows 用正斜杠）：

```yaml
- insert:
    - id: selfcheck-guard
      name: 'C:/Users/YOUR_NAME/.dsh/plugins/selfcheck-guard/index.mjs'
      config:
        settingsFile: 'C:/Users/YOUR_NAME/.dsh/quality-guard/settings.json'
        criteriaFile: 'C:/Users/YOUR_NAME/.dsh/plugins/selfcheck-guard/criteria.example.md'
        auditFile: 'C:/Users/YOUR_NAME/.dsh/quality-guard/audit.jsonl'
        dryRun: true          # 先演习，只记日志不打回
        maxReworks: 3
        timeoutMs: 60000
        # 输出预算由引擎按档位自动算，别填 maxTokens（填数字＝关掉自动预算）
```

完整示例见 [`examples/cordis.patch.example.yml`](examples/cordis.patch.example.yml)。改完重启 dsh（或重载 patch）。

`settings.json` 不存在也没关系：引擎会用 patch 里的静态配置 + `criteriaFile` 开跑。

### 2. 面板（可选）

```bash
# 拷到插件目录
~/.dsh/plugins/dsh-quality-guard/

# 在 profile 的 node_modules 里建目录联接（Windows）
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-quality-guard" "%USERPROFILE%\.dsh\plugins\dsh-quality-guard"
```

patch 里再追加一条按**包名**挂的：

```yaml
- insert:
    - id: quality-guard
      name: dsh-quality-guard
```

面板需要 `react ^18.2` 和 `@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-layout`（后两个 dsh 自带）。重启后侧边栏出现「质检」。

---

## 配置

两个来源，**活设置优先**：

1. `settingsFile`（`~/.dsh/quality-guard/settings.json`）——面板写的就是它，人也能手改；引擎每轮现读。
2. patch 里的静态 `config`——只在 ①读不到/读不懂时兜底（fail-open）。

| 字段 | 含义 | 范围 | patch 默认 | 面板默认 |
| --- | --- | --- | --- | --- |
| `enabled` | 总闸，关掉＝一条都不查 | bool | `true` | `true` |
| `dryRun` | 演习：只判断、只记日志、不打回 | bool | `true` | `true` |
| `triggers.minReplyChars` | 回复短于这个字数就跳过检查 | 0–20000 | `0` | `0` |
| `triggers.maxReworks` | 同一轮最多打回几次，防死循环 | 0–10 | `3` | `3` |
| `triggers.scoreThreshold` | 判官打分的及格线 | 0–100 | `70` | `70` |
| `judge.timeoutMs` | 判官超时就放弃，本条放行 | 1000–120000 | `60000` | `60000` |
| `judge.model` | 指定判官模型 `{provider, model}`；留空＝沿用当前会话的路由 | — | `null` | `null` |
| `reasoningEffort` | 判官思考多深、最多能输出多少 token——**这两项由插件自己定**（v1.3.0）：先用最省的那档，判不出来才升级；预算随档位一起涨 | `auto` | `auto` | `auto` |
| `onUnknown` | 判官两次都拿不到裁定（超时/断流/空输出）时：`pass` 放行，`rework` 打回重写 | `pass` \| `rework` | `rework` | `rework` |
| `auditFile` | 审计日志落点；**空字符串＝不写** | — | — | `~/.dsh/quality-guard/audit.jsonl` |
| `settingsFile` | 活设置文件落点 | — | — | — |
| `criteriaFile` | 判据文本文件；仅在活设置里没有 `criteria` 数组时启用 | — | — | — |

超出范围的数值会被夹回默认值（引擎侧 `index.mjs` 的 `readLive()`），面板侧则直接报人话错误。

**判官的档位和输出预算不用你填（v1.3.0）。** 面板上这两项已经撤掉，只剩一行说明：引擎先用最省的那档（`low`；`off` 会被上游 11133 拒，不可用），判不出来才升一档重判；预算（`maxTokens`）随档位一起涨，保证答案不会被推理挤没。手写 `settings.json` 里塞旧值（`low` / `high` / `judge.maxTokens`）还能跑，但面板一保存就归一成 `auto`——这是故意的：手填的档位和预算正是「答案被推理挤没」的来源，不该再当可调项。

### 判据怎么写

两种写法，二选一：

- **文本文件**（`criteriaFile`）：内容**原样**喂给判官，不解析。示例见 [`engine/criteria.example.md`](engine/criteria.example.md)。
- **面板**（`settings.json` 的 `criteria` 数组）：每条 `{id, label, enabled, text}`，勾掉的跳过；`exceptions` 是一个文本框，一行一条，拼正文时自动加 `- ` 前缀。

两者最终拼成同一段文本：

```
判据（任一条不满足即不合格）：
1. ……
2. ……

例外：
- ……
```

全部勾掉或全空 → 退回代码内置判据（宁可判得严，也不要静悄悄变成不查）。

---

## 已知行为（别当 bug）

**打回时界面上会多留一条旧回复。** 打回走 `agent.steer()`，而旧回复在这之前已经按 `surfaceOp: "append"` 落盘了，界面只收 append——改不了。设计取舍：你能同时对照看「长版」和「短版」。真要只保留最后一版，得改挂 `llm/stream`、攒完整条再判，那会牺牲流式体感。

**一切失败都放行（fail-open），但「失败」的定义收窄了（v1.1.0）。** 判官超时、报错、拿不到 llm 服务、没有模型路由、`settings.json` 读坏——仍然跳过检查继续会话。质检绝不该把会话卡住。但**判官已经吐出来的分数不再被当成失败丢掉**：断流、`max-tokens`、半截 JSON，只要分数写出来了就按分数判；拿不到分数还会换一个更便宜的提示补判一次；两次都没有才走 unknown 出口（审计记 `decision: "unknown"`，`onUnknown=rework` 时打回重写）。

**判官输出预算别调回 800（v1.3.0 起自动，不用再管这一项）。** 判官输出的是判定行 + `FIX:`，800 会被截断（v1.1.0 起判定压在第一行，截断只吃掉尾巴，所以不再是致命的，但理由会缺）。这是 v1.3.0 之前手填时代的坑：那时默认 4000；现在预算随思考档位自动涨，面板也不再给这个输入框。

**判官偏严不一定是判官错了。** 实测踩过一次：拿「早上七点，在小区门口集合」当「好回复」，判官却按第 3 条（不旁生枝节）和第 4 条（数值必带出处）判了 no——它没判错，是那段回复本身多给了地点、还带了没有出处的数值。**测判官之前先确认语料本身无歧义。**

**「宁可判不合格」这句会自己加戏。** 判官系统提示原先写的是「宁可判不合格，也不要放过铺垫」。实测同一批语料：苛刻版好回复 80/80/100，中性版 100/100/80，而两类坏回复在两版下完全一样（47/47/47、35/35/35）。**严格度没换来区分度，只换来了误伤**，所以 v1.2.0 改成「判 no 必须指得出具体哪句话」。

**「一个字都没吐」现在查得出来了（v1.0.1）。** 引擎原先只收 `text-delta`，也只把 `finish.kind === 'error'` 当错；可超时 abort 在 SDK 里报的是 `aborted`，token 被推理吃光报的是 `max-tokens`——两种都静悄悄走到「空文本 → 放行」。现在：`aborted` 当显式超时、文本为空时从 `reasoning-delta` 里再捞一次 JSON、审计补上 `finish` / `judgeMs` / `textChars` / `reasonChars` / `textSource`。兜底默认同步提到 `timeoutMs 60000`、`maxTokens 4000`。

**同一 turn 最多打回 `maxReworks` 次**，计数在内存里按 `session:turn` 分桶，进程重启清零。

---

## 隐私红线

`~/.dsh/quality-guard/audit.jsonl` 每一行都是**你真实对话的复述**：

```json
{"at":"…","turn":12,"session":"…","score":45,"failed":true,
 "worst":"只说『继续』，回复却甩出完整问题复盘…","fix":"先给结论，删掉没问的旁支…",
 "rework":0,"dryRun":false,"route":"…/…","chars":1180,
 "finish":"stop","judgeMs":4210,"textChars":96,"reasonChars":0,"textSource":"text",
 "verdict":"fail","decision":"fail","scoreSource":"checklist","retried":false,
 "checks":[{"id":1,"ok":true},{"id":2,"ok":false}],"incomplete":[3],"effort":"low"}
```

`worst` / `fix` 是判官写的原话，等于把你的对话摘要留在了磁盘上。所以：

- `.gitignore` 已挡掉 `*.jsonl`、`settings.json` 和一切备份——**别强行 `git add -f`**。
- 分享截图前，先看面板里的判据有没有混进私人设定（人设、口癖、内部项目名）。
- 想不留痕：`auditFile` 留空即可，质检照常工作。

---

## 自测

```bash
node engine/selftest.mjs
# → 218 passed, 0 failed
```

用假 llm，不联网、不花钱，覆盖：判据拼装、超时/报错放行、`maxReworks` 上限、`dryRun`、外部判据文件、活动设置覆盖 patch、v1.0.1 的三种判官异常（JSON 全在 reasoning、`aborted`、`max-tokens` 空产出）与审计诊断字段，v1.1.0 的分层抢救（行式 / 完整 JSON / 截断 JSON / 只给 verdict）、补判、unknown 出口、`onUnknown=rework`，思考档位（v1.2.0 默认 `low` / 可配 / 非法值 / 被上游拒绝自动退回 / 真错误不误判），v1.3.0 的自动档位与自动预算（`auto` 起步、判不出来才升级、预算随档位一起涨、旧值保存时归一），以及 v1.4.0 的逐条 0-10 打分（全满分 / 部分失分 / 第 1 条硬门槛 / 漏答压分母 / 越界分当未答 / 分号与全角冒号容错 / 截断仍能判 / 非数字输出走 unknown / `checks` 记分数与编号）。

`engine/fixtures/audit-regressions.json` 是从生产审计里导出的 **11 条真实漏判**原始判官输出，selftest 会逐条跑。同一套夹具跑 v1.0.1 的引擎是 4 条与预期相反（42 / 55 / 55 / 58 全部该打回却放行），跑当前版本全部正确。

---

## 为什么不逐条 yes/no，也不直接打分

**直接给 0-100 不行**：实测它打不稳。同一段回复连判 9 次：**40 / 1 / 2 / 20 / 20 / 20 / 30 / 25 / 55**（range 54），而且模型会自作主张把尺度换成 `SCORE: 2/10`——`2/10` 被当成 2 分。`temperature: 0` 也压不住（2 / 2 / 1），因为方差来自「选哪把尺子」，不是采样。

**逐条 yes/no 也不行**（v1.2.0–v1.3.1）：它确实是稳定的（range 0），但**只许 yes 和 no 就等于把判据钉成了二值**——判据表里只要有「保持某某人设」「结论要量化打分」这类与上下文相关的项，无关的技术答复就恒判 no，把 100 分的回复压到 60。生产审计里第 4 条 no 了 20 次、第 5 条 18 次（五条中最高），24 次打回里有 8 次由此产生（33%），全是误伤。加 `na` 第三态只能救急：用户随时会改判据，而程序不可能预先知道哪条会有「不适用」，多一个状态就多一类误读。

**v1.4.0 改成逐条 0-10**：每条判据各自拿一个 0-10 的分（量表 10/8/6/4/2/0 写死在提示里），总分由程序折算。这样「不适用」不再是第三种答案，而是提示里的一条规则——**客观加不了（无数值可标出处、纯技术答复、通篇无结论）打 10 不扣分；主观没加（该给结论没给、该说人话说了术语）照实扣**。判官只需要挑一个分数，不需要判断「这条算不算适用」。

实测量化（`.scratch/probe-judge-score10.mjs`，同一回复各判 4 次）：总分极差 good 8 / mid 6 / bad 5，平均 6.3；`temperature: 0` 反而更抖（平均 9.7，mid range 16），所以不用它。好回复 76~88、坏回复 35~42 分得开；中间档与好档有重叠，靠及格线（默认 70）而不是靠判官自觉。

顺带发现 token 去哪了：37 条带 `reasonChars` 的审计行里，**推理占判官输出的 91%**（最低 78%，最高 97.7%），答案本身平均只有 210 字符；而 `judgeMs` 只有 3.8–12.4 秒，从没接近 60 秒超时。所以「判官一个字都没吐」不是超时，是 4000 token 被推理吃光了。v1.2.0 因此把思考档位默认降到 `low`（`off` 会被上游以 11133 拒绝，不可用）；v1.3.0 干脆不让用户选了——档位和预算都由引擎自己调（见[配置](#配置)）。

复现脚本在 `.scratch/`（`probe-judge-variance.mjs`、`probe-judge-numbered.mjs`、`probe-v6-e2e.mjs`），需要本机 `workbuddy` 凭据，不随仓库分发。

---

## 环境

- 实测：DeepSeek Harness 桌面版 `0.2.1-rc.5`，Windows，Node `24.21.0`。
- 只用了 Node 内置模块，引擎零依赖；面板依赖 `react ^18.2`。
- macOS / Linux 路径分支未实测。

---

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

---

## License

MIT —— 见 [LICENSE](LICENSE)。

---

<details>
<summary>English</summary>

A pre-send quality gate for DeepSeek Harness: before an assistant reply reaches the user, a **second model** judges it against your written criteria and the reply is sent back for a rewrite if it fails. Mechanical rules (length, regex) cannot catch off-topic padding or jargon walls — semantic judgement can. `engine/` is the hook, `panel/` is an optional web UI. Everything fails open, so the gate can never wedge a session. MIT.

</details>
