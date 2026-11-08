# 更新日志

## v1.7.0 — 2026-11-07

**「给判官的提示词你也放在质检插件里让人可以随意修改」。** 之前决定判官松紧的两段字写死在 `engine/index.mjs` 里：system 消息（`JUDGE_SYSTEM`）和逐条打分规则/六档量表（`SCALE` + `scoreItemsPrompt` 里的规则块）。想收紧给分只能改代码、还要重启；这次把它们挪进 `settings.json`，和判据同等待遇。

### 新增两个设置字段（都可在面板里编辑）

- `judgeSystem`：判官的 system 提示词。
- `judgeRules`：逐条打分的规则 + 0/2/4/6/8/10 六档锚点量表。
- 两者是**顶层字符串**，落在 `~/.dsh/quality-guard/settings.json`；引擎 `readLive()` 每轮现读（`mtimeMs:size` 缓存），**改完下一轮就生效，不用重启**。**没有「留空＝默认」**：框里、`settings.json` 里、判官实际用的始终是同一份全文，两个框都不允许留空（面板前后端都拦），上限各 20000 字。想恢复出厂默认点面板「恢复默认」，它把默认全文写回 `settings.json`。引擎 `pickPrompt()` 只在老配置缺字段 / 文件被手改坏时兜底。
- **输出格式骨架写死不给改**：`scoreItemsPrompt` 里「第一行 `编号:分数`、第二行 `FIX:`」及问答/判据拼装留在代码里，只把中间规则块换成参数 `judgeRules`。理由：`parseScores()` 靠这个格式解析，放开让人改坏会整轮判不出来。占位符方案弃用（零学习成本）。

### 引擎 `engine/index.mjs`

- `JUDGE_SYSTEM` → `export const DEFAULT_JUDGE_SYSTEM`；删 `SCALE`，规则块 + 量表合成 `export const DEFAULT_JUDGE_RULES`（文字逐字照抄，行为不变）。
- `runJudge()` 的 `system` 改 `settings.judgeSystem ?? DEFAULT_JUDGE_SYSTEM`；`scoreItemsPrompt(..., judgeRules = DEFAULT_JUDGE_RULES)` 第 6 参由 `live.judgeRules` 传入。
- `readLive()` 加 `pickPrompt()` 读两个新字段；`liveNow()` 的回退对象补齐两字段。
- **行为中性**：两个字段用出厂默认全文 seed 进 `settings.json`，发给判官的字节与 v1.6.1 完全一致。

### 面板

- `panel/lib/settings.js`：`DEFAULT_JUDGE_SYSTEM` / `DEFAULT_JUDGE_RULES`（与引擎逐字一致）、`defaults()` / `normalize()` / `FIELD_HELP` 同步带上两字段（否则面板一保存就把新字段抹掉——`normalize()` 的未知字段丢弃规矩）。
- `panel/lib/client.js`：「什么情况不算违规」之后新增「判官提示词」一节，两个 textarea（系统提示 rows 5、打分规则 rows 12）；`toDraft()` / `fromDraft()` 带上两字段，`patchDraft()` 靠 `...current` 自动带过。

### 自测 `engine/selftest.mjs`

- 新增 3 例：默认走内置常量且格式骨架仍在；`settings.json` 自定义两字段生效且不再带内置规则；同一进程内热改 `settings.json`，第 2 轮就读到新提示词（破 `mtimeMs:size` 缓存）。

### 重载

- 引擎换了代码：**重启一次 DSH**（同路径改不重载，disable/enable 无效）。重启之后随便改提示词，再不重启。面板前端刷新页面（F5）看新框。

## v1.6.1 — 2026-11-05

**装了没人知道 = 没写。** 起因是查自己仓库的数据：1 个 star（本人点的）、外部 referrer 为 0、clone 全是自己的开发循环。功能没问题，问题是它进不了任何市场——三个 dsh 市场（dsh-market / dshget.com / plugin.dshx.dev）都从 `awesome-dsh-plugin/awesome-dsh-plugin` 同步，而那条收录流水线在 CI 里卡一条硬门槛：**`package.json` 必须在仓库根，或在 `packages/ packages/ plugins/ apps/` 子包里声明 `dsh.bundle`**。本仓库此前只有 `panel/package.json`，根上没有，等于永远进不去。

### 仓库根新增 `package.json`

- 把 `panel/package.json` 里的 manifest 提到根：`name: dsh-quality-guard`、`version: 1.6.1`、`type: module`、`exports`（`.` → `./panel/lib/index.js`、`./client`、`./engine`、`./cordis.patch.yml`）、`dsh.bundle.patch: ./panel/cordis.patch.yml`、`dsh.client`、`peerDependencies.react`。
- 补 `repository` / `homepage` / `bugs` / `keywords` / `files`——市场卡片和 npm 页面读这几个字段。
- **实测过**：`dsh plugin --profile web add <本地路径>` 之后 `dsh --profile web --dump-config` 输出里出现 `# == dsh-quality-guard` 与 `- id: quality-guard`，不再是「declares no dsh.bundle」的警告。
- 试完已把测试 profile 还原（`web` 的 `package.json` 回到无 dependencies 状态，node_modules 里的目录联接删掉）。

### README 新增「0. 面板一条命令装」

原先只有「拷目录 + 手改 patch + `mklink /J`」三步，对外人来说全是劝退点。现在第一节就是：

```bash
dsh plugin --profile web add github:wdj20050927/dsh-quality-guard
```

并写明验证方式（`--dump-config` 里找 `- id: quality-guard`）与「引擎不能这样装」的原因（引擎要按绝对路径挂、要指自己的 `settingsFile`）。

### 已知坑（写进 README 时踩到的）

- **git-hosted 装法会报 `ERR_PNPM_EPERM`**：`E… rename 'node_modules\dsh-quality-guard_tmp_23312_1' -> 'node_modules\dsh-quality-guard'`。原因是上一次失败留下了目录联接。删掉那个联接重跑就过了。
- **git-hosted 装出来 version 是 `0.0.0`**：pnpm 从 git 装不跑 `prepack`，读不到根 manifest 的 version。不影响功能，但 `package.json` 的 `version` 字段在 git 装法下不可信。
- 先装面板再装引擎是可以的：面板只写 `settings.json`，引擎每轮现读；没引擎时面板就是个空转的编辑器。

## v1.6.0 — 2026-11-05

用户原话：「关于质检这个，我希望要给出是哪个对话的第几轮 / 然后最严重的一条的内容就是 没有遵循好的质检词（得分/满分）」。两句各对应一处：面板认不出是哪场对话，他也说不出「哪把尺子没达标、差多少」。

### 引擎 `engine/index.mjs`

- **`worst` 从「第 N 条只拿到 X/10：判据正文」改成「没做到：判据中文名（X/10）」**。原来的 `第 N 条` 是 `checklistItems` 从 `composeLiveCriteria` 生成的 `1. text` 行里抠出来的**顺序号**——用户一动启用集合或顺序，历史行全部错位。改成取面板 `criteria[].label`（`先说核心结论`／`人设` 这种稳定中文名）。
- `checklistItems(criteria, labels = [])` 多收一个 label 数组，按「已启用判据的顺序」对齐；新增 `labelOf(item)`，没有 label 退回判据正文（超 40 字截断）。
- `readLive()` / `liveNow()` 一并返回 `criteriaLabels`，`composeLiveCriteria` 只写 `text` 不写 label 的老行为保持兼容。
- `checks` 每条多带 `label`，面板与审计对得上同一把尺子。

### 面板 `panel/lib/index.js`（宿主半侧）

- **`readAudit` 补 `judgeNth`**：按 `session + turn` 分组，组内从 1 数（1、2、3 这种小数字，对应 `rework` 0→1→2）。不能拿 `turn` 顶替，也不能拿整个会话累计（会数到几十）。计数扫整份日志后再切尾巴，否则分组会从中间截断。
- **`withTitles` 补对话标题**：先走 `sessionQuery.readTitleSnapshots`；实测 audit 里 22 个会话只有 5 个能查到（其余 `SESSION_QUERY_SESSION_NOT_FOUND`），于是加**磁盘退路**——扫 `~/.dsh/sessions/<workspace>/session-<uuid>/session.v4.jsonl.zstd`，按 zstd magic `28 b5 2f fd` 切帧逐帧解，从事件里倒序取最后一条 `session/title` 的 `data.title`。实测 17 个会话 240 ms 全部命中，覆盖率 5/22 → 22/22。
  - `zstdDecompressSync` 直接喂整文件只解出第一帧，必须自己切帧——这是退路存在的唯一理由。
  - 会话索引缓存 10 分钟（`SESSION_INDEX_TTL`），标题缓存 5 分钟（`TITLE_TTL`），单次调用 8 s 超时。
- **判官出错的行也补标题**：`withTitles` 的提前返回从 `row.error !== undefined` 改成只判 `row === null || typeof row !== 'object'`，此前 2 行「判官超时」没有会话名。

### 面板 `panel/lib/client.js`

- 表格 4 列 → **6 列**：`时间 / 对话 / 判官第几次 / 分 / 结果 / 最严重的那条`。
- `sessionCell`：主行显示标题，次行显示 8 位短号（只有标题没有号时不显示次行），鼠标悬停给完整 `session-<uuid>`。
- 「判官第几次」列渲染 `judgeNth`，悬停提示「对话第 N 轮」；老数据无 `judgeNth` 时退回 `turn`。

### 测试

- `engine/selftest.mjs` 三条断言同步：worst 里找中文名而不是「第 N 条」，新增「worst 是『判据名（得分/10）』格式」和「checks 也带上判据名」两条。**222 passed, 0 failed**。
- 面板渲染冒烟 `render-panel.mjs`：表头 6 列渲出，样例行 `["11-05 12:56","博主跟买与模拟盘方案 34c44afa","7","41","不过·打回","没做到：不旁生枝节（4/10）、人设（2/10）"]`。

### 升级注意

- 改 `engine/index.mjs` 后**光 disable+enable 不生效**：HMR 按模块文件身份（inode/大小/mtime）判断，同路径原地改不会重新 import。要么重启 dsh，要么把文件另存为新名字（如 `index-151.mjs`）再改 `cordis.patch.yml` 的 `name` 指过去。
- 改 `panel/lib/index.js` 后 `plugin_manager set_plugin`（`include:quality-guard`）关一次再开一次即可，不必重启；前端 `client.js` 需要刷新页面。
- 历史审计行不回填：170 行旧格式 `第 N 条 只拿到 X/10：…` 保持原样，面板只显示最后 20 条，按当轮 settings 反推 label 在判据顺序变动后必然错。

## v1.5.0 — 2026-11-03

用户原话：「改，必须改，你现在这个给分太宽泛了，谁都可以踢一脚，怎么行」。起因是他贴来一份堆了三张表、十几个小节的报告问「这是怎么通过的」——审计查出来 **84 分 pass**。

### 为什么能过（两条都查到了）

- **面板判据里没有一条管篇幅。** `composeLiveCriteria`（`engine/index.mjs`）里写着 `if (index === 0) return CRITERIA`：面板只要勾了一条判据，引擎内置的整份 `CRITERIA` 就被替换。而活设置里恰好没有内置那一条「不旁生枝节」，于是「没问的方向不要展开」这条规则从开局起就不存在。
- **及格线只在 70，且低分条目拦不住。** v1.4.0 起只有第 1 条低于 6 分才算硬门槛。v1.4.0 上线后的 9 条 `scoreSource:"scores"` 审计行里，45 个 check 的单条分数分布是 `{6:2, 8:9, 9:4, 10:30}`——**一条 0/2/4 都没有**。判官几乎不给低分，光比总分等于给了它当橡皮图章的空间。

### 引擎 `engine/index.mjs`

- **任一条低于 6 分即不合格**（`parseScores`）：`low: hits.filter((hit) => hit !== undefined && hit < 6)`；`score` 从「只看 `hits[0]`」改成 `hits.some((hit) => hit < 6)` 时按 59 折算。折算而不归零，是为了保住「扣了多少」的可读性，同时数学上必定不及格。
- **`scoreVerdict` 再加一道显式 fail**：`result.score < threshold || low.length > 0 ? 'fail' : 'pass'`。防止日后有人把 `scoreThreshold` 调到 50 以下，一条「第 3 条 2/10」的回复被放出去。
- **判官提示里的三条禁令重写**：第 1 条不许按「客观加不了」打 10；**任何一条低于 6 分整条回复直接不合格，别为了总分好看把明显缺东西的条打到 8**；也不许拿低分当报复（指不出具体哪一句就打 10）。原来「不许只给 10 或 0 走极端」「不许把可以写得更好当扣分理由」两条被替换——前者与「客观加不了打 10」冲突，后者已经被锚点量表和报复禁令盖住。

### 面板 `panel/lib/`

- `settings.js`：`defaults().triggers.scoreThreshold` 70 → **80**；`FIELD_HELP.scoreThreshold` 补一句「任一条判据低于 6 分也直接打回」。
- `client.js`：同一句提示同步到面板 UI。
- `package.json`：`1.4.0` → `1.5.0`。

### 活设置 `~/.dsh/quality-guard/settings.json`

- **补回「不旁生枝节」判据**（`id: no-tangents`，插在 `plain-words` 之后），正文按问题分量定篇幅：一句话能答清的不许铺成小节/表格/清单；没问过的方向、限定条件、例外情形一律不展开；用户明确要「详细说」时不扣分。**这是本机活设置漏掉的判据，不是新设计**——`panel/lib/settings.js` 的 `DEFAULT_CRITERIA` 里一直有它。
- `triggers.scoreThreshold` 70 → **80**。活设置每轮现读，**改它不用重启**。

### 测试

- `node engine/selftest.mjs` → **220 passed, 0 failed**（v1.4.0 基线 218）。
- 用例 35 从「非第 1 条失分不直接打回（83 分 pass）」改成「**任一条**低于 6 分都直接打回（49 分 fail、真回炉）」；新增 35b 守住边界：`1:10 2:6 3:10` → 87 分 pass（**6 分不触发否决**，6 分＝做到一半）。
- 用例 65 从「一条 4 分其余满分 → 80 分 pass」改成 **47 分 fail 回炉**。

## v1.4.0 — 2026-11-03

用户一句话：「判官在技术问答上判我没人设、没量化，把我 100 分的回复压到 60」——一查是**判据的规格写错了**，不是判官能力问题。

三条硬数据（`audit.jsonl`，358 行 / 63 行带 checks）：五条判据里第 4 条（保持某某人设）判 no **20 次**、第 5 条（结论要量化打分）**18 次**，是最高两项；只有这两条挂的行 17 行，本该 100 实得 60/40/24/80；24 次打回里有 **8 次**由此产生（33%）。判官越忠实执行这条写错的判据，破坏越大——yes/no 只给两个答案，而「保持人设」「结论要量化」这类判据在无关的技术答复上**本该不适用**。

先试过加 `na` 第三态，被用户否掉：「用户随时会去调整质检词，你不知道哪几条要打分、哪几条要 yes/no，所以我们就全用打分就行了」。于是：

### 引擎 `engine/index.mjs`

- **判法从逐条 yes/no 改成逐条 0-10 打分**。`checklistPrompt` → `scoreItemsPrompt`，`parseChecklist` → `parseScores`，`checklistVerdict` → `scoreVerdict`。判官对每条判据各给一个 0-10 的分，总分由程序折算。
- **量表锚点写死**（`const SCALE`，六档）：`10 分：完全做到…` / `8 分：基本做到，只有措辞上的小瑕疵。` / `6 分：做到一半，明显缺了东西。` / `4 分：大多没做到，只能算沾边。` / `2 分：基本没做到。` / `0 分：明确违反，并且你能指出具体是哪一句。` 没有锚点它会自由心证。
- **「不适用」从第三种答案降级成提示里的一条规则**：`客观加不了`（无数值可标出处／纯技术答复无人设冲突／通篇无结论／用户只问一句）**打 10，不扣分**；`主观没加`（该给结论没给、该说人话说了术语）照量表扣，**不许拿「不太适用」当借口送 10 分**。
- **第 1 条仍是硬门槛**：`第 1 条永远有判定对象（任何回复都有开头），不许按「客观加不了」打 10；它低于 6 分时整条回复直接不合格`——折算分上限压到 59。
- **分母恒等于「条数×10」，漏答按 0 分压着**（Fail-Closed）：`const rate = sum / (items.length * 10)`。不允许「少答几条把分母变小抬高分数」。越界分（`1:100`）与非整数一律当未答。
- **示例行第 1 条给 8 分**（`${item.id}:${index === 0 ? 8 : 10}`），防判官照着示例橡皮图章全打 10。
- 审计 `checks` 从 `{id, ok:true/false}` 改成 `{id, score:0-10}`；`scoreSource` 记 `'scores'`；`worst` 列出所有低于 6 分的条目。
- 顺带清掉 v1.4.0 里的 na 残留字段（`naCount`/`applicable`/`naSuspicious` 已从审计落盘删除），`scorePrompt` 的「按不适用处理」文案改为「照常打分」。

### 文档

- README 的时序图、清单模式说明、`## 为什么不逐条 yes/no，也不直接打分`（原「为什么不让判官直接打分」）三处按新判法重写，并把量化实测写进去。
- `panel/package.json` 版本 `1.3.0` → `1.4.0`。

### 测试

- `node engine/selftest.mjs` → **218 passed, 0 failed**（v1.3.1 基线 190）。用例 33–72 全部按打分语义重写，新增：全满分 / 部分失分 / 第 1 条硬门槛折算 59 / 漏答压分母 / 越界分当未答 / 全角冒号与分号容错 / 截断仍能判 / 非数字输出走 unknown / `checks` 记分数与判据编号 / 非第 1 条失分不再直接 fail。

### 实测依据

`.scratch/probe-judge-score10.mjs`（直连 `workbuddy/deepseek-v4.1-flash`，good/mid/bad 各判 4 次）：

| 样本 | plain 总分 | 极差 | `temperature: 0` | 极差 |
| --- | --- | --- | --- | --- |
| good | 84 / 80 / 76 / 80 | 8 | 84 / 80 / 88 / 80 | 8 |
| mid | 88 / 84 / 84 / 90 | 6 | 96 / 80 / 84 / 92 | 16 |
| bad | 35 / 40 / 35 / 40 | 5 | 38 / 38 / 42 / 37 | 5 |

平均极差 plain **6.3**、temp0 **9.7** → `temperature: 0` 反而更抖，不用它。逐条看：①②在 0~2 抖、③④恒 0、⑤（结论量化打分条）0~10 抖动最大。好回复 76~88、坏回复 35~42 分得开；中间档与好档有重叠，靠及格线（默认 70）兜住，不靠判官自觉。

## v1.3.1 — 2026-11-02

v1.3.0 上线当天在生产审计里露了真身：`raccoon/sn-deepseek-v4-1-flash-1017` 这个路由**不认任何思考档位**，而 v1.3.0 的「档位不被认就退回不传」兜底只接了 `llm.stream()` **抛错**那条路——它不抛错，把失败塞进 `finish.failure` 里。结果两个槽用同一个被拒的档位各撞一次，`decision:unknown` + `onUnknown:rework` 把用户白打回三轮（审计原文 `does not support reasoning effort "low" [0ms]`、`judgeMs:0`、`textChars:0`）。

### 引擎 `engine/index.mjs`

- **拒绝有两条路，现在两条都认**：`runJudge` 里新增 `finishFailure()`——流正常结束但 `finish` 是 `error` 且原文匹配档位拒绝（`/reasoning effort/i`、`/UNSUPPORTED_REASONING_EFFORT/i`、`/11133/`、`/不接受当前请求/`）时，同样退到「不传档位」重试一次，不再白判一槽。
- **路由级记忆**：`apply()` 里新增 `effortRefused`（`provider/model` → 是否拒过档位）。某个路由某轮拒过，下一轮起就不再带 `reasoningEffort`，并 `ctx.logger.warn` 一句。只记「明确说不支持档位」，502/超时不进表。
- 自测新增用例 62/63/64 钉住三件事：`finish.failure` 式拒绝要退回、`finish` 真错误**不许**误当档位拒绝、拒过的路由下一轮只调一次上游。

### 部署备忘（不是代码，但下次别踩）

- `apply start` 只重建 cordis fiber，**ESM 模块缓存不会失效**；同一路径改内容不会重载，**换文件名才会**。想免重启上线引擎，必须换文件名 + `plugin_manager` 开关 `include:selfcheck-guard`（注意：改过挂载点 `name` 后该 entry 会变 `unaddressable`，之后只能改 patch 文件 + 重启，所以**最终要把 `name` 收回 `index.mjs`**，靠换文件名上线只在当下那次有效）。

### 测试

- `node engine/selftest.mjs` → **190 passed, 0 failed**（v1.3.0 基线 181）。

## v1.3.0 — 2026-11-01

用户一句话：「对于判官的几档和优化我的感觉是你不要让用户自己去填，肯定有一个最优解……然后做就行了。」这一版就把「判官思考多深」和「判官最多输出」从**手填**改成**插件自己定**。

### 引擎 `engine/index.mjs`

- **`reasoningEffort` 新增 `'auto'` 且为默认**：判官先用最省的那档（`low`；`off` 会被上游 11133 拒，不可用）起步，拿不到裁定才升一档重判。
- **输出预算自动算**：`maxTokens` 随档位一起涨，保证判定行与 `FIX:` 不会被推理挤没；手写死 `judge.maxTokens` 仍当显式上限（逃生舱）。
- **`onUnknown` 默认改成 `'rework'`**：判官两次都拿不到裁定就打回重写，宁可多花一轮，也不静默放行。
- **活设置的顶层 `reasoningEffort` 现在代码端也认**（9a86f7b）：面板写在**顶层**（和 `onUnknown` 一样），引擎早期只读 `judge.reasoningEffort`，导致面板改了引擎看不见。

### 面板 `panel/`

- 删掉「判官思考多深」五档选择与「判官最多输出」数字框，换成一行只读说明：「思考档位和输出预算由判官自己定：先用最省的档，判不出来才升级；预算随档位一起涨，保证答案不会被推理挤没。不用你填。」
- `settings.js` 的 `defaults()` / `normalize()` / `FIELD_HELP` 与 `client.js` 的 `HELP` 同步：保存时写 `reasoningEffort: 'auto'`，`judge` 里不再写 `maxTokens`（旧文件里的 `judge.maxTokens` 保存时丢弃、五档旧值归一成 `auto`）。
- `onUnknown` 的默认值 `'pass'` → `'rework'`：与引擎默认同向，不允许两套默认（面板落盘的 `settings.json` 会盖掉引擎兜底）。

### 文档

- README「配置」章：删掉 `judge.maxTokens` 一行与五档说明，`reasoningEffort` 改为 `auto`，并加一段「判官的档位和输出预算不用你填」；安装示例不再写 `maxTokens`，注明填数字＝关掉自动预算。
- `examples/settings.example.json` 同步：`reasoningEffort: 'auto'`、`onUnknown: 'rework'`、去掉 `judge.maxTokens`；`examples/cordis.patch.example.yml` 删掉 `maxTokens: 4000` 兜底行，改成注释说明。
- 补上缺失的 v1.2.1 独立小节（原先只在 README 里写了一句）。

### 测试

- `node engine/selftest.mjs` → **181 passed, 0 failed**（v1.2.0 基线 137）：本版新增自动档位 / 自动预算 / `onUnknown` 默认用例。

## v1.2.1 — 2026-11-01

补 v1.2.0 的账：清单模式上线后，判据里只要有一条永远不满足的项（实测是「保持可爱的某某人设」这类风格项），「任一条 no 即整条打回」就会让 `scoreThreshold` 形同虚设——一条 80 分的好回复照样被打回、回炉重写。

### 引擎 `engine/index.mjs`

- **及格与否只看折算分数**（`checklistVerdict(text, items, threshold)`）：折算分低于 `triggers.scoreThreshold` 才打回，不再「有哪一条判了 no 就打回」。
- **第 1 条仍是硬门槛**：第 1 条（结论前置）判 no 时折算上限压到 59 分，必然低于及格线——它不过就是整段跑偏了。
- 实测：同一条 80 分回复从 `decision=fail`、`steered=1` 变成 `pass`、不回炉；坏回复 12 分仍然 `fail`、回炉。判据表里有「人设 / 口吻」这类风格项时，及格线才真的起作用。

### 文档

- README 补「及格与否只看折算出来的分数」一段；`engine/index.mjs` 文件头补 v6.1 及格线语义（47f44c5、b7b65c3）。

## v1.2.0 — 2026-11-01

v1.1.0 治的是「分数被丢掉了」，这一版治的是**分数根本不该那么难产、也不该那么飘**。

先摆实测（直连 `workbuddy/deepseek-v4.1-flash`，脚本在 `.scratch/probe-judge-*.mjs`）：

| 现象 | 数字 |
| --- | --- |
| 判官输出里推理占多少 | 37 条带 `reasonChars` 的审计行：**均值 91%，最低 78%，最高 97.7%**；答案本身平均只有 210 字符 |
| 判官耗时 | `judgeMs` 3.8s ~ 12.4s，**从未接近 `timeoutMs=60000`** → 超时不是主因，token 被推理吃光才是 |
| 同一段回复连判 9 次（0-100 打分） | **40 / 1 / 2 / 20 / 20 / 20 / 30 / 25 / 55**，range 54；模型还会自作主张换成 `SCORE: 2/10` |
| 同一段回复连判 3 次（`temperature: 0`） | 2 / 2 / 1 —— **`temperature: 0` 不是解药**，方差来自尺度选择不是采样 |
| 换成逐条 yes/no | 好/中/坏各 3 次：**100/100/100、47/47/47、35/35/35**，range 0 |

### 引擎 `engine/index.mjs`

- **清单模式（默认）**：判据里有 ≥2 条编号条目时，不再问「给个 0-100 分」，而是让判官逐条判 `1:yes 2:no 3:yes`。程序按通过条数折算分数，判据正文原样喂进去（编号不会像条目名那样被模型复述走样）。
- **第 1 条是硬门槛**：判据第 1 条（结论前置）判 no 时，折算上限压到 59 分——就算其余全过也不及格。理由：用户那张判据表里第 1 条本来就是「最核心的结论放最前面」，它不过就是整段跑偏了。
- **判定压在第一行**：`1:yes 2:no …` 放第一行，`FIX:` 放第二行。复用 v5「分数第一行」的思路——截断只吃尾巴。
- **答漏了编号不算全过**：只答了部分条目时，按**已答部分**折算，并在审计 `incomplete` 里记下漏了哪几条（不静默当合格，也不因为漏答就整条作废）。
- **判据没有编号条目时自动退回老问法**（`SCORE: 0-100`），所以自定义判据写成散文也不会失灵。
- **`reasoningEffort` 可配**，默认 `'low'`。实测：
  - `off` → 上游直接拒（`上游 11133：模型不接受当前请求`），**不可用**；
  - `minimal` → 推理 461 字符（默认 high 是 944~1144）；
  - `low` → 推理 252 字符，出分稳定。
  - 宿主/上游不认这个档位时（`UNSUPPORTED_REASONING_EFFORT` / 11133），自动退回「不指定」重试一次，不把整轮判死。
- **判官系统提示从「苛刻」改成「只核对判据」**：实测「宁可判不合格」会让它自己加戏——同一批语料，苛刻版好回复 80/80/100，中性版 100/100/80，而两类坏回复在两版下完全一样（47/47/47、35/35/35）。**严格度没换来区分度，只换来了误伤**。现在要求「判 no 必须指得出具体哪句话」。
- **审计新增字段**：`checks`（逐条判定）、`incomplete`（漏答的编号）、`effort`（这一轮实际用的档位）。
- **及格只看折算分数，不看「有没有哪条判了 no」**（`checklistVerdict(text, items, threshold)`）。这一条是拿**活判据**实测出来的：用户判据表里有「保持可爱的某某人设」这种风格项，普通技术回复永远不满足；若按「任一条 no 即 fail」，一条 80 分的回复照样被打回、`scoreThreshold` 形同虚设（实测 good 80 分 `decision=fail`、`steered=1`）。现在改为按分数与 `scoreThreshold` 比，第 1 条仍是硬门槛（判 no → 满分压到 59 → 必然低于及格线）。修后同一条回复 80 分 → `pass`、不回炉；坏回复 12 分 → `fail`、回炉。
- **活设置里的 `reasoningEffort` 现在两处都认**：面板写在**顶层**（和 `onUnknown` 一样），而引擎早期只读 `judge.reasoningEffort`，导致面板改了引擎看不见。现在顶层优先、`judge.reasoningEffort` 兜底。

### 测试

- `node engine/selftest.mjs` → **137 passed, 0 failed**（v1.1.0 是 100）：新增清单全过/部分过/第 1 条不过/漏答编号/清单模式下仍认 JSON 与 SCORE/提示格式/档位默认与配置/非法档位/档位被拒自动退回/上游 11133 退回/真错误不误判成档位问题/截断清单/无编号判据退回老问法/活设置顶层 `reasoningEffort` 生效。
- 另跑了一次**真模型端到端**（`.scratch/probe-v6-e2e.mjs`：真 `apply()` + 真 adapter + 真判据文件），9 次全部 `scoreSource=checklist`、0 条 unknown、0 条 error：好回复 100/100/100，坏回复 35/35/35。

### 面板 `panel/`

- 新增「判官思考多深」五档选择（关 / 最少 / 少 / 中 / 多），读写 `settings.reasoningEffort`；非法值退回默认而不报错。
- 版本 `1.1.0` → `1.2.0`。

### 已知限制

- **中等质量的回复仍会飘**：实测「中」那档回复在端到端里跑出 47 / 100 / 100（range 53）。好与坏两头已经钉住，中间地带没有。
- `onUnknown` 默认仍是 `'pass'`（与旧行为一致）。
- `reasoningEffort: 'off'` 在本机 relay 上不可用，只能用 `low`。

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
