/**
 * selfcheck-guard v3 — 「发出去之前，先让另一个模型读一遍」。
 *
 * v3（2026-10-31）：配置从 patch 挪到 `settingsFile`（`~/.dsh/quality-guard/settings.json`）。
 *  GUI 页「质检」写的就是这个文件；引擎每轮现读（mtime+size 缓存），所以**页面改完下一轮就生效**，
 *  不用重载、不用重启。文件读不到/读不懂 → 退回 patch 里的静态配置（fail-open）。
 *
 * WHY（2026-10-31 用户两次纠正）：
 *  - v1 用机械判据（字数 ≤800、有数值必须有锚点）——用户当场否定：
 *    「根本不是问题」。他要的从来不是长度，是**用最简单最直白的方式讲最核心的因素**。
 *  - 这条判据没有正则能表达：它要读语义、要对照他的原问题看有没有答偏。
 *    ⇒ 机械判据换成**语义判定**（第二个模型当裁判）。
 *  - 用户原话：「多花 token 就花，我的认知带宽是最宝贵的」。所以每轮多一次模型调用是划算的。
 *
 * 机制（与 reply-length-guard 同一条闸门，不猜）：
 *  - `agent/turn-stopping` 在轮次要结束、next-step 队列为空时触发；
 *    listener 期间往 next-step 投一条消息，轮次就不结束，模型继续（agent.steer 的落点）。
 *  - 判定必须由**另一个实例**做：同一条上下文里的自我检查无效
 *    （Huang et al. arXiv 2310.01798；CoVe arXiv 2309.11495 之所以有效，是因为独立轮次）。
 *
 * 边界：
 *  - 同一 turn 最多回炉 maxReworks 次（默认 3，2026-10-31 用户指定），防死循环。
 *  - 判官调用失败/超时/拿不到模型 → **放行**（fail-open），绝不因为质检卡住会话。
 *  - `dryRun: true` 时只写日志不拦截。
 *
 * v4（2026-11-01）：判官「一个字都没吐」不再是谜。
 *  原先审计里只剩一句 `judge returned no JSON: `，分不清是超时被 abort 还是 token 被推理吃光——
 *  因为只收 `text-delta`，也只把 `kind === 'error'` 当错，而 SDK 把 abort 报成 `aborted`。
 *  现在：也收 `reasoning-delta`（文本为空时从推理里捞 JSON）、`aborted` 当显式超时、
 *  审计补 `finish`/`judgeMs`/`textChars`/`reasonChars`/`textSource`，
 *  兜底默认提到 `timeoutMs 60000`、`maxTokens 4000`。
 *
 * v5（2026-11-01）：学 anthropics/content_moderation 的三值逻辑，把「拿不到裁定就放行」改成显式 UNKNOWN。
 *  实测 269 行审计里 11 行 `judge returned no JSON`，其中 5 行半截 JSON 已经带了分数、4 行分数低于阈值
 *  ——它们本该被打回，却因为 `JSON.parse` 要一个完整的 `}` 而被静默放行。这是**漏判**，不是噪音。
 *  三处改动：
 *  1. **先给分，再给理由**：判官改成行式输出（`SCORE:` 是第一行），截断先吃掉 worst/fix，吃不掉分数；
 *     解析器分层兜底（行式 → JSON → 正则抢救），且**只要抢救到分数就按分数判**，不再要求完整 JSON。
 *  2. **分数优先于 finish**：`error`/`aborted` 也可能是「已经吐出分数才断的」，先解析，拿到分数就不抛。
 *  3. **三值裁定**：`pass | fail | unknown`。unknown 不再默认放行——先补判一次（只让判官补输出分数行），
 *     仍拿不到就按 `onUnknown` 处置（v5 默认 `pass`，v7 起默认 `rework`）。unknown 一律写进审计，可回查。
 *  出处：anthropics/claude-cookbooks `capabilities/content_moderation/engine.py` 的
 *  「Any unknown that would matter yields decision `needs_review` rather than a confident verdict」。
 *
 * v6（2026-11-01）：v5 只治了「拿不到裁定」，没治**量具本身**。直连上游实测（见 `.scratch/probe-judge-*.mjs`）：
 *  1. **推理吃光 token**：39 行带诊断的审计里，判官输出中推理字符占比 avg 91%、min 78%、max 97.7%，
 *     而真正答案平均只有 210 字符。`maxTokens 4000` 全被思考吃掉，答案只剩尾巴——这才是 `no JSON` 的根。
 *     病根是判官没传 `reasoningEffort`，继承了 profile 的 `high`。
 *     实测同一提示：`high` 推理 944~1144 字符，`low` 只要 252 字符。改成默认 `low`，宿主拒绝时自动退回不传。
 *  2. **「0-100 一个整数」是坏量具**：同一段回复、同一提示连判 9 次，得到
 *     40 / 1 / 2 / 20 / 20 / 20 / 30 / 25 / 55（range 54），`temperature: 0` 也压不住。
 *     更糟的是模型会自作主张换尺度，吐出 `SCORE: 2/10`、`SCORE: 1/4`——被当成 2 分、1 分。
 *  3. 换成**逐条判据 yes/no**（让模型只做它擅长的二选一，分数由程序算）后，同一批用例：
 *     good 100/100、mid 80/80/80、bad 24/35/35，方差从 54 降到 0~11，且好坏分得开。
 *  ⇒ v6 的判官默认走**清单模式**：判据逐条 yes/no，程序折算分数；第 1 条（结论前置）是硬门槛。
 *    判据里没有编号条目时才退回「SCORE: 0-100」的老问法。
 *    注：这个「清单模式」在 v1.4.0 被逐条 0-10 打分取代，见文件末尾 v1.4.0 段。
 *
 * v6.1（2026-11-01，拿**活判据**实测才暴露的）：清单模式起初写成「任一条判 no 就整条 fail」，
 *  结果用户判据表里「保持可爱的某某人设」这种风格项普通技术回复永远不满足——
 *  一条 80 分的回复照样被打回、`scoreThreshold` 形同虚设。
 *  ⇒ 改成只看**折算分数**与 `scoreThreshold` 比；第 1 条判 no 时满分压到 59，仍然必挂。
 *
 * v7（2026-11-02，契约 v1.3.0）：v6 把档位钉死在 `low`、预算钉死在 `maxTokens 4000`——两个都是拍的数。
 *  生产审计（39 行带诊断）里 11 条 `judge returned no JSON` 的 reasonChars 最高 4614、答案均 210 字符，
 *  即 4000 的预算被推理吃光；而 judgeMs 1876~12442ms 远没到 `timeoutMs=60000`——
 *  也就是说**该升档重试的时候它没升，只是拿同一个档位原地重问一遍**。另外 `off` 档在 workbuddy 上会撞 11133。
 *  ⇒ v7 两件事：
 *    1. `reasoningEffort` 新增 `auto`（默认）：从 `AUTO_START` 起手，主判拿不到裁定时
 *       **向上升一级**再补判一次（low→medium→high，到顶为止），而不是原地重问。显式 off/minimal
 *       仍然尊重用户（含原有的「上游不认就退回不传」逻辑）。
 *    2. `judge.maxTokens` 缺省/null 时按「档位 + 判据条数」自动算（`autoBudget`，见下），
 *       随档位升高一起涨；给了数字才固定用那个数字（老行为的逃生舱）。
 *
 * v1.4.0（2026-11-03，契约 v1.4.0）：v7 的两件事都被生产数据否掉了，这位用户最后拍板的是
 *   「别猜」——档位不发、预算固定、超时不留、重试不换挡。
 *  - 升档重试：audit 336 行里 `attempts=2` 共 7 行，**成功 0 行**，全是 provider 拒 `medium`
 *    （`does not support reasoning effort "medium"`）→ 白多一次上游调用，还因为拿不到裁定额外
 *    把用户打回一轮。用户原话：「这样换挡，重想通通没有」。
 *  - 自动预算：v1.3 之后 reasonChars p90 只有 2440 字符、最坏 3448 字符 ≈ 2369 token，
 *    4976 的预算**一次都没被逼近过**；而压小预算是**单向有害**的（思考量不降、只是把答案挤没，
 *    旧引擎 11 条 `judge returned no JSON` 就是这么来的）。所以固定 32768，详见 `JUDGE_MAX_TOKENS`。
 *  - 档位：`effort` 按官方说法只是 "soft guidance"，发它换不来任何确定性，只会撞
 *    「这个 model 不认识这一档」。本机唯一两次成功（`raccoon` 60 分、`qodercn` 100 分）都是
 *    **不发档位**（审计里记作 `effort:"default"`）。
 *  - 超时：用户明确不要截止（`judge.timeoutMs` 从此不生效），上游那层 5 分钟仍在中继里。
 *  - **判法从逐条 yes/no 改成逐条 0-10 打分**：yes/no 只给判官两个答案，判据里那些与上下文
 *    相关的项（「保持可爱的某某人设」「结论要量化打分」）在无关的技术答复上恒判 no，
 *    把本该 100 分的回复压到 60（生产审计：第 4 条 no 20 次、第 5 条 18 次，24 次打回里 8 次
 *    由此产生）。加 `na` 第三态只能救急——用户随时改判据，程序不可能预知哪条会不适用。
 *    ⇒ 每条判据各拿一个 0-10 分（`DEFAULT_JUDGE_RULES` 六档锚点，能在 settings.json 里改），「客观加不了打 10、
 *    主观没加拉低」变成提示里的一条规则而不是第三种答案。实测同一回复各判 4 次，
 *    总分极差 good 8 / mid 6 / bad 5（平均 6.3），`temperature: 0` 反而更抖（9.7）。
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'selfcheck-guard'

import { appendFileSync, readFileSync, statSync } from 'node:fs'

/** 事件在 dispatch 时才用到 ctx；llm 通过 ctx.inject 现取（见 apply 注释）。 */
export const inject = []

/** 每个 config key 都必须在这里，打错字要当场报错而不是静默失效。 */
const ALLOWED_KEYS = new Set([
  'enabled',
  'dryRun',
  'maxReworks',
  'timeoutMs',
  'maxTokens',
  'minReplyChars',
  'scoreThreshold',
  'onUnknown',
  'reasoningEffort',
  'auditFile',
  'criteriaFile',
  'settingsFile',
  'model',
])

/**
 * v1.4.0：**判官输出预算 = 32768，固定值，不再按档位算。**
 *
 * 为什么固定死在 32768 而不是「按 p99 自动算」：
 *  - 官方 thinking-steering 页：`max_tokens` 是请求的**硬顶**（thinking 与回答共用一份），
 *    `effort` 只是 soft guidance（https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost）。
 *    也就是说**压低上限换不来「少想一点」，只会把答案截没**——旧引擎 11 条 `judge returned no JSON`
 *    正是这么来的（thinking-troubleshooting 页原话：long thinking pass 可以把预算在回答完成前吃光）。
 *  - v1.3 之后的生产实测：reasonChars p90 2440 字符、最坏 3448 字符 ≈ 2369 token，占 4976 的 48%，
 *    **一次都没逼近过上限**。所以「够不够」这件事根本没有调参的必要，直接给到封顶。
 *  - 32768 就是本机能拿到的最大值：中继 `dsh-workbuddy-relay/src/adapter.mjs:281`
 *    `defaultMaxTokens: Math.min(upstreamCeiling ?? defaultMaxTokens(), defaultMaxTokens())`，
 *    而 `index.js:138` 的默认是 32768，再大也会被 `Math.min` 截回来。
 */
export const JUDGE_MAX_TOKENS = 32768

/**
 * v1.4.0：**默认不发送任何档位**。
 *
 * `effort` 按官方说法只是 "soft guidance"，「shapes behavior but doesn't guarantee a token count」，
 * 发它换不来确定性，只会撞「这个 model 不认识这一档」。生产证据：
 *  - `raccoon/sn-deepseek-v4-1-flash-1017` 对 `medium` 被拒 9 次、对 `low` 也被拒（说明它自己报的能力表与实际不符）；
 *  - 本机唯一两次**成功**的调用（`raccoon` 60 分、`qodercn/gfmodel` 100 分）都是**不发档位**，
 *    审计里记作 `effort:"default"`。
 * 所以 `reasoningEffort: 'auto'`（默认）＝不发；只有用户显式选了一个档位才发。
 */
export const AUTO_START = 'default'

/** 唯一一种「要发送的档位」白名单。`default` = 不发。 */
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high']

/** `default` 以及其他任何认不出的值都归到「不发」。 */
function effortToSend(settings) {
  const value = settings?.reasoningEffort
  return typeof value === 'string' && value !== 'auto' && value !== 'default' && EFFORTS.includes(value)
    ? value
    : undefined
}

/**
 * 本槽真正用的输出预算，以及它是不是自动算的（审计要如实把这两件事分开记）。
 *
 * v1.4.0 优先级：活设置 `judge.maxTokens` 有数字 → 用那个数字（逃生舱，面板已不再暴露）；
 * 否则 **恒定 `JUDGE_MAX_TOKENS`**。`maxTokensAuto` 字段保留，值恒为 `false`——
 * 老审计里的 `true` 是 v1.3 自动预算留下的记号，保留字段只是为了让新老审计能一起统计。
 */
function slotBudget(settings) {
  if (typeof settings?.maxTokens === 'number') {
    return { maxTokens: settings.maxTokens, maxTokensAuto: false }
  }
  return { maxTokens: JUDGE_MAX_TOKENS, maxTokensAuto: false }
}

/** 本插件注入消息的 source.kind，用于自我识别（不会被当成用户说的话）。 */
const GUARD_SOURCE = { kind: 'plugin:selfcheck-guard' }

/**
 * 判官的系统提示：只判表达与命中，不判内容对错。
 *
 * v6 校准（`.scratch/probe-v6-calib2.mjs`，同一批语料各判 3 次）：
 * 「宁可判不合格」这句会把它推向过度严格——好回复 80/80/100，中性版 100/100/80，
 * 而两类坏回复在两版下都是 47/47/47 与 35/35/35，**严格度没换来任何区分度**。
 * 所以把「宁可判不合格」换成「判据没写的不算违规」：
 * 判据本身就是用户的原话，判官只负责核对，不该自己加戏。
 */
export const DEFAULT_JUDGE_SYSTEM = [
  '你是一个质检员。你面前有「用户的问题」和「助手即将发出的回复」。',
  '你不评价内容是否正确、是否充分，只判定这段回复**读起来是否符合用户给出的判据**。',
  '判据没写的要求不算违规；判据的前提在本轮不成立时（比如回复里没出现数值、用户只问了一个问题），该条算满足。',
  '判不合格必须能指出回复里具体是哪句话违反了哪条判据；指不出具体句子就判合格。',
].join('\n')

/** 判据：直接抄用户的原话，不加解释。 */
const CRITERIA = [
  '判据（任一条不满足即不合格）：',
  '1. 最核心的那一个因素/结论放在最前面直接给出；不许先复述问题、先讲背景、先铺垫。',
  '2. 用最简单最直白的话说，像跟人当面讲话；不许学术腔、不许术语堆砌。',
  '   （术语本身就是用户要的信息时不算违规；难度大的是「用大白话把难点说清」。）',
  '3. 不旁生枝节：用户没问的方向不要主动展开；限定条件、例外情形不要全铺一遍。',
  '4. 该带的出处一条不少：出现具体数值或文献结论时必须带可回查锚点（URL/DOI/PMID/arXiv/文件路径）。',
  '   （这一条是用户明确要求的例外：省字不许省出处。）',
  '5. 如果用户的问题里含多个问句，必须按「问题1+回答1、问题2+回答2」的顺序逐条对应。',
  '',
  '注意：如果用户这一轮明确要了「详细说 / 完整版 / 全部列出来」，那么长和细都不算违规，只看有没有答在点子上。',
].join('\n')

/** 把一条消息的内容块折成纯文本，并报告它是否带 tool-call。 */
function inspectMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return { text: content, hasToolCall: false }
  if (!Array.isArray(content)) return { text: '', hasToolCall: false }
  let text = ''
  let hasToolCall = false
  for (const block of content) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') text += block.text
    else if (block.type === 'tool-call') hasToolCall = true
  }
  return { text, hasToolCall }
}

/** 安全地拿一份会话事件快照（拿不到就当空）。 */
function snapshot(session) {
  try {
    const events = session?.snapshotEvents?.()
    return Array.isArray(events) ? events : []
  } catch {
    return []
  }
}

/**
 * 找出「这一轮真正要发出去的那条回复」和「它回应的问题」。
 *  - 回复 = 最后一条**不带 tool-call** 的 assistant 消息（干活中间的说明不算）；
 *  - 问题 = 那条回复之前最近一条 source.kind === 'user' 的消息（跳过本插件自己注入的）。
 */
function lastExchange(session) {
  const events = snapshot(session)
  let reply
  let replyIndex = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const message = event.data?.message ?? event.message
    const { text, hasToolCall } = inspectMessage(message)
    if (hasToolCall || text.trim() === '') continue
    reply = text
    replyIndex = i
    break
  }
  if (reply === undefined) return undefined
  let question
  for (let i = replyIndex - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    const kind = event.data?.source?.kind ?? 'user'
    if (kind !== 'user') continue
    const { text } = inspectMessage(event.data)
    if (text.trim() === '') continue
    question = text
    break
  }
  return { reply, question }
}

/** 这一轮实际派发用的模型路由：最近一条 request/header 说了算。 */
function lastRoute(session) {
  const events = snapshot(session)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'request/header') continue
    const config = event.data?.header?.config
    const provider = config?.provider
    const model = config?.model
    if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
      return { provider, model }
    }
  }
  return undefined
}

/**
 * 拼给判官的原文（两段都截断，避免把一整个文件塞进判官）。
 *
 * v5 起要的是**行式输出且分数第一行**：截断只吃掉尾巴，吃不掉已经写出来的分数。
 * 旧版要一个完整 JSON，`{"score": 42, "verdict": "fa` 这种半截就整条作废——实测 5 条审计
 * 里半截 JSON 已经带了分数，4 条低于阈值却因此被放行。
 */
function judgePrompt(question, reply, criteria = CRITERIA) {
  const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit)}\n……（后略 ${text.length - limit} 字）`)
  return [
    '【用户的问题】',
    question === undefined ? '（这一轮没有找到用户的原话，只判定表达是否直白、是否旁生枝节；没有判定对象的条目按客观加不了处理，不扣分）' : clip(question, 1500),
    '',
    '【助手即将发出的回复】',
    clip(reply, 5000),
    '',
    criteria,
    '',
    '只输出下面四行，不要任何其他文字、不要 JSON、不要代码块围栏。第一行必须是 SCORE：',
    'SCORE: 0-100 的整数（100 = 完全符合全部判据）',
    'VERDICT: pass 或 fail',
    'WORST: 最严重的那一条问题，一句话',
    'FIX: 具体怎么改，一句话，可执行',
  ].join('\n')
}

/**
 * 从判据正文里抠出编号条目（`1. xxx` / `1、xxx` / `1) xxx`）。
 *
 * 逐条打分靠这些编号定位——判据是用户自己编辑的 md，条目名字可能很长、
 * 可能带括号解释，让模型复述名字容易走样，**编号不会**。
 * 少于 2 条就当没有清单（单条判据折算分数没意义，退回老的 SCORE 问法）。
 */
function checklistItems(criteria, labels = []) {
  const text = String(criteria ?? '')
  const items = []
  const pattern = /^[ \t]*(\d{1,2})[.、)][ \t]*(\S.*)$/gm
  let match
  while ((match = pattern.exec(text)) !== null) {
    /**
     * 中文名（`先说核心结论`）从面板的 `criteria[].label` 来，按「已启用判据的顺序」对齐。
     * 没有就留空串，`labelOf` 会退回判据正文。
     */
    const label = typeof labels[items.length] === 'string' ? labels[items.length].trim() : ''
    items.push({ id: Number(match[1]), text: match[2].trim(), label })
  }
  return items.length >= 2 ? items : []
}

/**
 * 一条判据在面板/回炉文案里怎么称呼：有中文名用中文名，没有就退回判据正文。
 *
 * 为什么不写「第 N 条」：N 只是「已启用判据的顺序号」，用户一改启用集合或顺序就全错位，
 * 历史行再也对不上；「先说核心结论」「人设」这类中文名是稳定的，正文也比编号好认。
 */
function labelOf(item) {
  const label = typeof item.label === 'string' ? item.label.trim() : ''
  if (label !== '') return label
  const text = typeof item.text === 'string' ? item.text.trim() : ''
  return text.length <= 40 ? text : `${text.slice(0, 40)}……`
}

/**
 * v1.7.0：出厂默认的「打分规则 + 六档量表」。之前叫 SCALE、写死在 scoreItemsPrompt 里，
 * 现在整段放进 settings.json 的 judgeRules 字段——框里、文件里、判官实际用的都是这一份全文。
 * 这个常量只在首次生成 settings.json / 点「恢复默认」时写进去；判官每轮只读 settings.json。
 * 输出格式骨架（第一行「编号:分数」、第二行 FIX:）仍写死在 scoreItemsPrompt 里，不给改。
 */
export const DEFAULT_JUDGE_RULES = [
  '请逐条给上面每一条判据打分，0 到 10 的整数。',
  '',
  '打分前先分清两件事，这是唯一容易判错的地方：',
  '- **客观加不了**：这一条在本轮根本没有判定对象。例：判据要求给数值标出处，而回复里一个数值都没有；判据要求人设不许前后矛盾，而这段是纯技术答复、通篇没有自称和称呼；判据要求给结论的重要性量化打分，而这段通篇没有给出任何结论；判据要求「多个问句逐条对应」，而用户只问了一句。',
  '  这种情况打 **10**，不扣分——不是它做得差，是没东西可做。',
  '- **主观没加**：这一条有判定对象，但回复没做到或只做到一半。哪怕只找到一句能指出来的问题，也按下面的量表扣分，不许拿「不太适用」当借口送 10 分。',
  '',
  '量表，每一档都有硬判据，对号入座：',
  '- 10 分：完全做到，找不到一句要改的（或客观加不了，见上）。',
  '- 8 分：基本做到，只有措辞上的小瑕疵。',
  '- 6 分：做到一半，明显缺了东西。',
  '- 4 分：大多没做到，只能算沾边。',
  '- 2 分：基本没做到。',
  '- 0 分：明确违反，并且你能指出具体是哪一句。',
  '',
  '- 第 1 条永远有判定对象（任何回复都有开头），不许按「客观加不了」打 10。',
  '- **任何一条低于 6 分，整条回复直接不合格**，不管你给总分打了多少。所以别为了「总分好看」把明显缺东西的条打到 8 分——6 分以下就是该打 6 分以下。',
  '- 也不许拿低分当报复：指不出具体哪一句违反，就按「客观加不了」打 10。',
].join('\n')

/**
 * 逐条打分的提示：让判官给每条判据一个 0-10 的整数，**得分压在一行里放在最前面**。
 *
 * 为什么不是「给个 0-100 的分数」：直连上游实测同一段回复连判 9 次得
 * 40/1/2/20/20/20/30/25/55（range 54），模型还会自作主张换成 `SCORE: 2/10`。
 * 为什么不是 yes/no：三态（yes/no/na）被用户否了，而且「哪条该 yes/no、哪条该 na」
 * 本身就不该由引擎猜——判据是用户随时在改的。
 * 逐条 0-10 实测：good/mid/bad 各 4 次，总分极差 8/6/5，好 76~88、坏 35~42 分得开。
 * 得分放第一行是 v5「分数第一行」那招的复用：截断只吃尾巴。
 */
function scoreItemsPrompt(question, reply, criteria, items, brief = false, judgeRules = DEFAULT_JUDGE_RULES) {
  const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit)}\n……（后略 ${text.length - limit} 字）`)
  // 示例的满分项留 8 不给 10：整行都对 10 的样例会训练判官当橡皮图章（v1.4.0 实测）。
  const sample = items.map((item, index) => `${item.id}:${index === 0 ? 8 : 10}`).join(' ')
  return [
    '【用户的问题】',
    question === undefined ? '（这一轮没有找到用户的原话，只判定表达是否直白、是否旁生枝节；第 1 条仍照常打分）' : clip(question, brief ? 600 : 1500),
    '',
    '【助手即将发出的回复】',
    clip(reply, brief ? 2000 : 5000),
    '',
    criteria,
    '',
    judgeRules,
    '',
    '然后严格按下面的格式输出。',
    `第一行必须是全部得分，格式为「编号:分数」，用空格隔开，一条都不许漏，例如：${sample}`,
    brief
      ? '只输出这一行得分，不要 FIX、不要解释。'
      : '第二行必须是 FIX: 失分最多的那条怎么改，一句话，可执行',
    '不要任何其他文字、不要 JSON、不要代码块围栏、不要解释。',
  ].join('\n')
}

/**
 * 逐条打分解析：`1:8 2:10 3:10 …`（容忍 `1. 8` / `1：8` / 逗号分隔 / `8/10` 这种写法）。
 *
 * 每条的分数**必须**落在 0~10 内，越界一律当没答（宁可补判一次，也不要让一个
 * 写错的 `100` 变成满分）。漏答的编号记进 `missing`，仍占分母照扣。
 */
function parseScores(text, items) {
  const raw = String(text ?? '')
  const hits = items.map((item) => {
    /**
     * 数字后面不能紧跟数字（`1:8 0` 这种打字错误要能被发现），
     * 但允许 `8/10`、`8 分`：判官爱这么写。
     * 不能套 `\b`——汉字不是 `\w`，中文量词后面根本没有词边界。
     */
    const pattern = new RegExp(
      `(?:^|[\\s,，;；])${item.id}\\s*[:：.、)]?\\s*(\\d{1,3})(?![0-9])`,
      'i',
    )
    const match = pattern.exec(raw)
    if (match === null) return undefined
    const value = Number(match[1])
    return Number.isInteger(value) && value >= 0 && value <= 10 ? value : undefined
  })
  const missing = items.filter((_item, index) => hits[index] === undefined)
  const answered = hits.filter((hit) => hit !== undefined)
  const sum = answered.reduce((total, score) => total + score, 0)
  /**
   * 总分＝得分率，**分母恒等于判据总数**。
   * 漏答的编号一律按 0 分压着——这是 Fail-Closed 的选择：判官少答一条，
   * 不能靠「分母跟着变小」把分数抬高（那样截断会变成白送满分）。
   * 已答出来的分照样算，`incomplete` 会记下漏了哪几条，补判槽还有一次机会。
   * 一条都没答出来时 `score` 为 undefined，由裁定器抛错走补判。
   */
  const rate = answered.length === 0 ? undefined : sum / (items.length * 10)
  const fix = /^[ \t>*\-]*FIX[ \t]*[:：][ \t]*(.+)$/im.exec(raw)
  return {
    hits,
    missing: missing.map((item) => item.id),
    answered: answered.length,
    sum,
    total: items.length,
    fix: fix === null ? '' : fix[1].trim(),
    /**
     * **任一条低于 6 分就是硬门槛**：满分只按 59 折算（必然低于及格线，直接打回）。
     *
     * v1.4.0 起初只让第 1 条当门槛，理由是「人设/量化这类风格项在技术答复上永远拿不到满分」。
     * 但 v1.4.0 已经用「客观加不了打 10」治好了那个病——不适用时它给满分，给低分就是真没做到。
     * 用户 2026-11-03 拍板（原话「你现在这个给分太宽泛了，谁都可以踢一脚，怎么行」）：
     * 每条判据都得能一票否决，否则等于加了五条建议而不是五条规矩。
     * 折算而不是直接归零：保留「扣了多少」的可读性，同时保证数学上必定不合格。
     */
    low: hits.filter((hit) => hit !== undefined && hit < 6),
    score:
      rate === undefined
        ? undefined
        : hits.some((hit) => hit !== undefined && hit < 6)
          ? Math.round(rate * 59)
          : Math.round(rate * 100),
    complete: missing.length === 0,
  }
}

/**
 * 逐条打分的裁定器：把 `1:8 2:10 …` 折成和 `parseVerdict` 同形的结果。
 *
 * 答不全（漏了编号）**照样算分**——已答出来的部分是真实判定，丢掉太浪费（v5 的老毛病）。
 * 只有第 1 条都没答出来时才抛给补判。
 *
 * **任一条判据低于 6 分就不合格**（v1.5.0 起）。v1.4.0 起初只让第 1 条当门槛，
 * 理由是「人设/量化这类风格项在技术回复上永远拿不到满分」——但 v1.4.0 的「客观加不了打 10」
 * 已经治好了那个病，剩下的低分都是真没做到。用户原话：「你现在这个给分太宽泛了，谁都可以
 * 踢一脚，怎么行」。所以：低于 6 分的条目把满分折算到 59，**并且**判定直接记 fail，
 * 两道保险——折算保证分数本身就不及格，显式 fail 保证以后改及格线也不会放出这种回复。
 * 第 1 条都没答出来时才抛给补判。
 */
function scoreVerdict(text, items, threshold = 70) {
  const raw = String(text ?? '')
  const result = parseScores(raw, items)
  const first = result.hits[0]
  if (first === undefined || result.score === undefined) {
    /**
     * 判官没按编号答——但可能按老格式答了（`SCORE: 62` / 完整 JSON / 半截 JSON）。
     * 那照样算数：要的是裁定，不是格式。**先走三层抢救，抢救不到才抛。**
     */
    return parseVerdict(raw)
  }
  const low = items
    .map((item, index) => ({ item, score: result.hits[index] }))
    .filter((entry) => entry.score !== undefined && entry.score < 6)
  return {
    score: result.score,
    /**
     * 两道保险：折算分数已经低于及格线，这里再把 verdict 显式钉成 fail。
     * 只在分数上做文章的话，日后有人把 `scoreThreshold` 调到 50 以下，
     * 一条「第 3 条 2/10」的回复就能被放行——那不是用户要的「每条都能踢一脚」。
     */
    verdict: result.score < threshold || low.length > 0 ? 'fail' : 'pass',
    /**
     * v1.5.1：worst 从「第 N 条只拿到 X/10：判据正文」改成「判据中文名（X/10）」。
     * 用户原话：「最严重的一条的内容就是 没有遵循好的质检词（得分/满分）」——
     * 他要的是**哪把尺子没达标 + 差多少**，不是让他在面板上自己数第几条。
     * 中文名（label）来自面板判据的 `label` 字段；没有就退回判据正文（见 `labelOf`）。
     */
    worst:
      low.length === 0
        ? ''
        : `没做到：${low.map((entry) => `${labelOf(entry.item)}（${entry.score}/10）`).join('、')}`,
    fix: result.fix,
    scoreSource: 'scores',
    /**
     * v1.4.0：`checks` 从 `ok:true/false` 改成 `score:0-10`（没答出来的是 undefined）。
     * 不改这里，事后就查不出「这条为什么扣分」「哪条判官一直给满/一直扣」。
     * v1.5.1：顺手把中文名一起落进审计，历史行不用再去猜「第 3 条」对应哪条判据。
     */
    checks: result.hits.map((hit, index) => ({
      id: items[index].id,
      label: labelOf(items[index]),
      score: hit,
    })),
    incomplete: result.complete ? undefined : result.missing,
  }
}

/** 行式输出：`SCORE: 62`（容忍 markdown 的 `-`/`*`/`>` 前缀与全角冒号）。 */
const SCORE_LINE = /^[ \t>*\-]*SCORE[ \t]*[:：][ \t]*(\d{1,3})/im
const VERDICT_LINE = /^[ \t>*\-]*VERDICT[ \t]*[:：][ \t]*(pass|fail)/im
const WORST_LINE = /^[ \t>*\-]*WORST[ \t]*[:：][ \t]*(.+)$/im
const FIX_LINE = /^[ \t>*\-]*FIX[ \t]*[:：][ \t]*(.+)$/im
/** 兜底抢救：任何位置出现 `"score": 42` 都认（含被截断的 JSON）。 */
const SCORE_JSON = /"score"\s*:\s*"?(\d{1,3})"?/i
const VERDICT_JSON = /"verdict"\s*:\s*"(pass|fail)"/i

const clampScore = (value) => Math.min(100, Math.max(0, value))

/**
 * 从模型输出里抠出裁定。三层兜底，**任何一层拿到分数就算数**：
 *  1. 行式 `SCORE:`（v5 的主格式，分数在第一行，最抗截断）；
 *  2. 完整 JSON（老格式，判官习惯性吐 JSON 时也认）；
 *  3. 正则抢救 `"score": 42`（JSON 被截断在半路上时的唯一活路）。
 * 三层都拿不到分数才抛错——那才是真的「判官什么都没说」。
 */
function parseVerdict(text) {
  const raw = String(text ?? '')
  const pick = (pattern) => {
    const match = pattern.exec(raw)
    return match === null ? undefined : match[1]
  }
  const build = (score, verdict, worst, fix, scoreSource) => ({
    score: clampScore(score),
    verdict: verdict === undefined ? 'unknown' : verdict.toLowerCase(),
    worst: worst ?? '',
    fix: fix ?? '',
    scoreSource,
  })

  const lineScore = pick(SCORE_LINE)
  if (lineScore !== undefined) {
    return build(
      Number(lineScore),
      pick(VERDICT_LINE),
      pick(WORST_LINE)?.trim(),
      pick(FIX_LINE)?.trim(),
      'lines',
    )
  }

  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1))
      const score = Number(parsed?.score)
      if (Number.isFinite(score)) {
        const verdict = parsed?.verdict === 'fail' || parsed?.verdict === 'pass' ? parsed.verdict : undefined
        return build(
          score,
          verdict,
          typeof parsed?.worst === 'string' ? parsed.worst : undefined,
          typeof parsed?.fix === 'string' ? parsed.fix : undefined,
          'json',
        )
      }
    } catch {
      // 半截 JSON：交给第三层抢救。
    }
  }

  const salvageScore = pick(SCORE_JSON)
  if (salvageScore !== undefined) {
    return build(
      Number(salvageScore),
      pick(VERDICT_JSON),
      undefined,
      undefined,
      'salvage',
    )
  }

  /**
   * 最后一条：判官明确写了 fail，只是没给数字。
   * 「宁可判不合格」——明确说了不合格，不该因为缺个数字就放行。
   * 这条只在 verdict 是 fail 时生效；写了 pass 却没分数不算数（没有依据的放行不接受）。
   */
  const explicitVerdict = (pick(VERDICT_LINE) ?? pick(VERDICT_JSON) ?? '').toLowerCase()
  if (explicitVerdict === 'fail') {
    return {
      score: undefined,
      verdict: 'fail',
      worst: pick(WORST_LINE)?.trim() ?? '',
      fix: pick(FIX_LINE)?.trim() ?? '',
      scoreSource: 'verdict-only',
    }
  }

  const preview = raw.trim() === '' ? '（空输出）' : raw.slice(0, 200)
  throw new Error(`judge returned no score: ${preview}`)
}

/** finish 原因折成审计里能读的一个词。 */
function finishLabel(finish) {
  if (finish === undefined || finish === null) return 'none'
  return typeof finish.kind === 'string' && finish.kind !== '' ? finish.kind : 'unknown'
}

/**
 * 文本为空时，从推理通道里捞一次 JSON（实测有模型把该说的话全放在 reasoning 里）。
 * 返回 { text, source }，source ∈ 'text' | 'reasoning' | 'none'。
 */
function salvageText(text, reasoning) {
  if (String(text).trim() !== '') return { text, source: 'text' }
  const reason = String(reasoning ?? '')
  if (reason.includes('{') && reason.includes('}')) return { text: reason, source: 'reasoning' }
  return { text, source: 'none' }
}

/**
 * 调一次判官，返回它的裁定（外加这次调用的诊断字段）。
 *
 * v5 起**先解析、再判失败**：`finish === 'error'` / `'aborted'` 也可能是「分数已经吐出来了才断的」，
 * 旧版先抛错就把已经写出来的分数丢了（实测 11 条漏判全是这么来的）。
 * 顺序：解析 → 有分数就返回 → 没分数才按 finish 抛显式原因。
 *
 * v6 起：`parse` 由调用方给——逐条打分模式传 `scoreVerdict`，老问法传 `parseVerdict`。
 *
 * v1.4.0：三处减法。
 *  1. **不再自己设截止**（删掉了原来的 `setTimeout(() => controller.abort(), settings.timeoutMs)`）：
 *     用户的判断是「截止又不能把问题解决，只会把已经想出来的东西丢掉」。`settings.timeoutMs`
 *     从此只作为旧键被接受，不参与任何逻辑。注意中继自己还有 5 分钟一层
 *     （`dsh-workbuddy-relay/src/http.mjs:19`），那层删不掉，最坏卡 5 分钟。
 *  2. **档位默认不发**：见 `AUTO_START` 的注释。只有用户显式选了档位、且这个路由没拒过它，才发。
 *  3. **本槽的预算**由调用方算好（现在是恒定值），`plan` 里只剩 `maxTokens` 一项。
 */
async function runJudge(llm, route, promptText, settings, parse = parseVerdict, effortState = {}, plan = {}) {
  const controller = new AbortController()
  const started = Date.now()
  let text = ''
  let reasoning = ''
  let finish
  const budget = plan.maxTokens
  const budgetAuto = plan.maxTokensAuto === true
  /** 本槽要用哪个档位：默认「不发」，用户显式选了才发。 */
  const slotEffort = plan.effort
  let effortUsed = effortState.unsupported === true ? undefined : slotEffort
  const meta = () => ({
    judgeMs: Date.now() - started,
    finish: finishLabel(finish),
    textChars: text.length,
    reasonChars: reasoning.length,
    effort: effortUsed ?? 'default',
    maxTokens: budget,
    maxTokensAuto: budgetAuto,
  })
  const fail = (message) => {
    const error = new Error(message)
    error.judge = meta()
    return error
  }
  const reset = () => {
    text = ''
    reasoning = ''
    finish = undefined
  }
  const collect = async (effort) => {
    const options = {
      provider: route.provider,
      model: route.model,
      system: settings.judgeSystem ?? DEFAULT_JUDGE_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }],
      maxTokens: budget,
      signal: controller.signal,
    }
    // 不传 = 继承 profile 的推理档位（本机是 high），那是 token 被吃光的原因。
    if (effort !== undefined) options.reasoningEffort = effort
    const stream = llm.stream(options)
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
      else if (chunk?.type === 'finish') finish = chunk.reason
    }
  }

  /**
   * 档位可能不被宿主认（`UNSUPPORTED_REASONING_EFFORT`）或被上游直接拒（workbuddy 对 `off` 回 11133）。
   * 一旦确认不支持就记在 `effortState` 上，之后不再白试一次——但绝不让它变成「不查」。
   * 用独立的 state 对象而不是往 settings 上挂字段：live 设置是每轮现读的，挂上去会丢。
   */
  /**
   * v1.3.1：**拒绝有两条路进来**。
   *  - 抛错：`llm.stream()` 直接 throw（老版只接了这条）；
   *  - 不抛错，把失败塞进 `finish.failure`（实测 `raccoon/sn-deepseek-v4-1-flash-1017` 对 `low` 就是这样，
   *    `error: does not support reasoning effort "low" [0ms]`，judgeMs=0、textChars=0）。
   * 老版漏了第二条，于是「退到不指定档位」的兜底不触发，两个槽都用同一个被拒的档位各撞一次，
   * 最后 decision=unknown + onUnknown=rework，用户被白白打回三轮。所以两条路都要认。
   */
  const refusal = (message) =>
    /reasoning effort/i.test(message) ||
    /UNSUPPORTED_REASONING_EFFORT/i.test(message) ||
    /11133/.test(message) ||
    /不接受当前请求/.test(message)
  /** finish 里带的失败原文；不是失败返回 undefined。 */
  const finishFailure = () => {
    if (finishLabel(finish) !== 'error') return undefined
    const failure = finish?.failure
    return failure === undefined || failure === null ? '' : String(failure.message ?? failure)
  }

  try {
    await collect(effortUsed)
  } catch (error) {
    /**
     * 两类拒绝都要认：
     *  - 宿主侧 `does not support reasoning effort "…"` / `UNSUPPORTED_REASONING_EFFORT`；
     *  - 上游侧 workbuddy 的 `11133 模型不接受当前请求`（实测 `off` 就撞这个）、
     *    raccoon 的 `does not support reasoning effort "low"`。
     * 只有「真的发了档位」才谈得上退回；没发档位还报这种错，那就是真错误，原样抛。
     */
    const message = String((error && error.message) || error)
    if (effortUsed === undefined || !refusal(message)) throw error
    effortState.unsupported = true
    effortUsed = undefined
    reset()
    await collect(undefined)
  }
  // 第二条路：没抛错，但 finish 里写着「不支持这个档位」。同样退到不指定，别让这一槽白判。
  if (effortUsed !== undefined) {
    const message = finishFailure()
    if (message !== undefined && refusal(message)) {
      effortState.unsupported = true
      effortUsed = undefined
      reset()
      await collect(undefined)
    }
  }
  const info = meta()
  const picked = salvageText(text, reasoning)

  // 先抢救分数：流断了不代表它没给过分。
  let verdict
  let parseError
  try {
    verdict = parse(picked.text)
  } catch (error) {
    parseError = error
  }
  if (verdict !== undefined) {
    return { ...verdict, ...info, textSource: picked.source }
  }

  if (info.finish === 'error') {
    throw fail(`judge stream failed: ${String(finish?.failure?.message ?? 'unknown')} [${info.judgeMs}ms]`)
  }
  if (info.finish === 'aborted') {
    // v1.4.0 引擎自己不再 abort；这条只剩「别人（宿主/中继/会话取消）掐断」一种来源。
    throw fail(`judge aborted after ${info.judgeMs}ms by an outside signal`)
  }
  if (picked.text.trim() === '') {
    throw fail(
      `judge produced no text (finish=${info.finish}, ${info.judgeMs}ms, reasonChars=${info.reasonChars}, maxTokens=${budget}, effort=${info.effort})`,
    )
  }
  throw fail(
    `${String((parseError && parseError.message) || parseError)} [finish=${info.finish}, ${info.judgeMs}ms, textChars=${info.textChars}, reasonChars=${info.reasonChars}, effort=${info.effort}]`,
  )
}

/**
 * 补判用的短提示：只要一个分数。
 *
 * 三值逻辑的「Unknown 出口」在 anthropics 那边是「转人工」；我们没有人工，
 * 于是先给判官**第二次、更便宜的机会**——只让它输出一行 `SCORE:`，连理由都不要。
 * 这一步专门救「理由写太长把 token 写光」「推理把 token 吃光」这两类漏判。
 */
function scorePrompt(question, reply, criteria = CRITERIA) {
  const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit)}\n……（后略 ${text.length - limit} 字）`)
  return [
    '【用户的问题】',
    question === undefined ? '（未找到，第 1、5 条照常打分）' : clip(question, 800),
    '',
    '【助手即将发出的回复】',
    clip(reply, 2500),
    '',
    criteria,
    '',
    '只输出一行，不要任何解释、不要 JSON、不要代码块围栏：',
    'SCORE: 0-100 的整数（100 = 完全符合全部判据）',
  ].join('\n')
}

/**
 * v7（契约修订 D）：打回提示会被模型照抄进最终回复。
 *
 * 生产实测：子代理被打回后，用户看到的开头就是这行方括号头——
 * 「【质检未过·24 分·已被打回第 1/3 轮】—— 收到，按你的问 1+答 1 重写」，
 * 而判官自己的 fix 写的正是「结论没前置」。所以两条文案末尾都把话说明白。
 */
const NO_REPEAT_HINT = '（这条提示不用在回复里复述，直接按要求重写。）'

/** 回炉时塞回去的那条消息。 */
function notice(verdict, attempt, maxReworks) {
  const head =
    verdict.score === undefined
      ? `【质检未过·判官判定不合格·已被打回第 ${attempt}/${maxReworks} 轮】`
      : `【质检未过·${verdict.score} 分·已被打回第 ${attempt}/${maxReworks} 轮】`
  const lines = [
    head,
    verdict.worst === '' ? '这段回复不是用户要的样子。' : verdict.worst,
    verdict.fix === '' ? '' : `改法：${verdict.fix}`,
    '按用户的要求重写这条回复：最核心的那一点先说，用最直白的话讲；删掉铺垫、背景、他没问的旁支；数值和文献出处一条不少。',
    NO_REPEAT_HINT,
  ]
  return lines.filter((line) => line !== '').join('\n')
}

/** 三值裁定里 unknown 落到 rework 时的文案（不带分数，因为真没有分数）。 */
function noticeUnknown(attempt, maxReworks) {
  return [
    `【质检未过·判官这一轮没给出可用的判定·已被打回第 ${attempt}/${maxReworks} 轮】`,
    '按用户的要求重写这条回复：最核心的那一点先说，用最直白的话讲；删掉铺垫、背景、他没问的旁支；数值和文献出处一条不少。',
    NO_REPEAT_HINT,
  ].join('\n')
}

/** Register the semantic self-check guard. */
export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(
      `${name}: unknown config key(s) ${unknown.join(', ')} — allowed keys: ${[...ALLOWED_KEYS].sort().join(', ')}`,
    )
  }
  const bool = (key, fallback) => {
    const value = source[key] === undefined ? fallback : source[key]
    if (typeof value !== 'boolean') throw new TypeError(`${name}: ${key} must be a boolean`)
    return value
  }
  const int = (key, fallback, min) => {
    const value = source[key] === undefined ? fallback : source[key]
    if (!Number.isSafeInteger(value) || value < min) {
      throw new TypeError(`${name}: ${key} must be a safe integer >= ${min}`)
    }
    return value
  }
  /**
   * v7：`maxTokens` 变成「可缺省」——缺省/null 表示自动预算（`autoBudget`），给了数字才固定。
   * 非法值仍然当场报错，且报错文案与老 `int` 一致。
   * v1.4.0：缺省/null 一律落到 `JUDGE_MAX_TOKENS`（32768），不再自动算。
   */
  const optionalInt = (key, min) => {
    const value = source[key] === undefined || source[key] === null ? undefined : source[key]
    if (value === undefined) return undefined
    if (!Number.isSafeInteger(value) || value < min) {
      throw new TypeError(`${name}: ${key} must be a safe integer >= ${min}`)
    }
    return value
  }
  const settings = {
    enabled: bool('enabled', true),
    dryRun: bool('dryRun', true),
    maxReworks: int('maxReworks', 3, 0),
    /**
     * v1.4.0：这个键**还在**（老挂载点里写着 60000，删掉它会让 patch 校验失败），
     * 但已经**不参与任何逻辑**——判官不再自己设截止。见 `runJudge` 的注释。
     */
    timeoutMs: int('timeoutMs', 60000, 1000),
    maxTokens: optionalInt('maxTokens', 64),
    minReplyChars: int('minReplyChars', 0, 0),
    scoreThreshold: int('scoreThreshold', 70, 0),
    onUnknown: 'rework',
    reasoningEffort: 'default',
    auditFile: '',
    criteriaFile: '',
    settingsFile: '',
    model: undefined,
  }
  if (source.settingsFile !== undefined) {
    if (typeof source.settingsFile !== 'string') throw new TypeError(`${name}: settingsFile must be a string`)
    settings.settingsFile = source.settingsFile
  }
  if (source.auditFile !== undefined) {
    if (typeof source.auditFile !== 'string') throw new TypeError(`${name}: auditFile must be a string`)
    settings.auditFile = source.auditFile
  }
  if (source.criteriaFile !== undefined) {
    if (typeof source.criteriaFile !== 'string') throw new TypeError(`${name}: criteriaFile must be a string`)
    settings.criteriaFile = source.criteriaFile
  }
  if (source.onUnknown !== undefined) {
    if (source.onUnknown !== 'pass' && source.onUnknown !== 'rework') {
      throw new TypeError(`${name}: onUnknown must be 'pass' or 'rework'`)
    }
    settings.onUnknown = source.onUnknown
  }
  if (source.reasoningEffort !== undefined) {
    const effort = source.reasoningEffort
    // v1.4.0：`auto` 保留为旧名的别名，一律等价于 `default`（＝不发档位）。
    if (effort !== 'auto' && effort !== 'default' && !EFFORTS.includes(effort)) {
      throw new TypeError(`${name}: reasoningEffort must be one of default/off/minimal/low/medium/high`)
    }
    settings.reasoningEffort = effort === 'auto' ? 'default' : effort
  }
  if (source.model !== undefined) {
    const model = source.model
    if (typeof model !== 'object' || model === null || Array.isArray(model)) {
      throw new TypeError(`${name}: model must be an object { provider, model }`)
    }
    if (typeof model.provider !== 'string' || model.provider === '' || typeof model.model !== 'string' || model.model === '') {
      throw new TypeError(`${name}: model.provider and model.model must be non-empty strings`)
    }
    settings.model = { provider: model.provider, model: model.model }
  }

  /**
   * 拿 llm 服务。
   *
   * ⚠️ 2026-10-31 实测教训（dsh-workbuddy-relay/index.js:165-178）：本插件是用**绝对路径**
   * 挂在 profile patch 里的，这种挂载方式下模块导出的 `export const inject` 不被采信，
   * 直接读 `ctx.llm` 会抛 `cannot get property "llm" without inject`。
   * 正解是 `ctx.inject([...], scoped => …)` 现开一个带注入的 scoped fiber。
   */
  let llmService
  const capture = (scoped) => {
    try {
      llmService = scoped?.get?.('llm') ?? scoped?.llm
    } catch {
      llmService = undefined
    }
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['llm'], (scoped) => capture(scoped))
    } catch {
      // 退化到运行时现取。
    }
  }

  /** session.id → Map(turn → { reworks })。 */
  const stats = new Map()
  const bucket = (sessionId, turn) => {
    let perTurn = stats.get(sessionId)
    if (perTurn === undefined) {
      perTurn = new Map()
      stats.set(sessionId, perTurn)
    }
    let entry = perTurn.get(turn)
    if (entry === undefined) {
      entry = { reworks: 0 }
      perTurn.set(turn, entry)
    }
    return entry
  }

  ctx.on('session/disposed', (session) => {
    stats.delete(session?.id)
  })

  /**
   * 每次判决落一行 JSONL。dryRun 期间看不出来判得准不准，全靠这个文件。
   * 写失败一律吞掉：审计器不该弄坏会话。
   * `file` 由调用方给（活设置可能改了 auditFile），空串＝不写。
   */
  const audit = (record, file) => {
    if (typeof file !== 'string' || file === '') return
    try {
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`)
    } catch {
      // 吞掉。
    }
  }

  let warned = false
  const warnOnce = (text) => {
    if (warned) return
    warned = true
    try {
      ctx.logger?.warn?.(text)
    } catch {
      // Logger 不可用，吞掉。
    }
  }

  /**
   * 判据来源：配置了 criteriaFile 就每次现读那个 md（改完立刻生效，不用重载），
   * 否则用代码里内置的 CRITERIA。读不到/读空 → 退回内置。
   */
  const criteriaText = () => {
    if (settings.criteriaFile === '') return CRITERIA
    try {
      const text = readFileSync(settings.criteriaFile, 'utf8').trim()
      if (text !== '') return text
      warnOnce(`${name}: criteriaFile is empty, using built-in criteria`)
    } catch (error) {
      warnOnce(`${name}: cannot read criteriaFile: ${String((error && error.message) || error)}`)
    }
    return CRITERIA
  }

  /**
   * 把面板里那份「判据 + 例外」拼成给判官看的正文。
   * 全都没勾/全空 → 退回内置 CRITERIA（宁可判得严格，也不要静悄悄变成不查）。
   *
   * v1.5.1：顺带把**已启用判据的中文名**按同样的顺序吐出来（`labels`），
   * 因为正文里只有编号和正文、没有中文名，而回炉文案和审计要的是中文名
   * （用户原话：「最严重的一条的内容就是 没有遵循好的质检词（得分/满分）」）。
   */
  const composeLiveCriteria = (list, exceptions) => {
    const lines = ['判据（任一条不满足即不合格）：']
    const labels = []
    let index = 0
    for (const item of list) {
      if (!item || item.enabled === false) continue
      const text = typeof item.text === 'string' ? item.text.trim() : ''
      if (text === '') continue
      index += 1
      lines.push(`${index}. ${text}`)
      labels.push(typeof item.label === 'string' ? item.label.trim() : '')
    }
    if (index === 0) return { text: CRITERIA, labels: [] }
    const extras = typeof exceptions === 'string' ? exceptions.trim() : ''
    if (extras !== '') {
      lines.push('')
      lines.push('例外：')
      for (const line of extras.split(/\r?\n/)) {
        if (line.trim() !== '') lines.push(`- ${line.trim()}`)
      }
    }
    return { text: lines.join('\n'), labels }
  }

  const pickInt = (value, fallback, min, max) => {
    const number = Number(value)
    if (!Number.isInteger(number) || number < min || number > max) return fallback
    return number
  }
  const pickBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

  /** v1.7.0：判官提示词字段。面板保证 settings.json 里永远是非空全文；
   *  这里只在老配置缺字段 / 文件被手改坏时兜底用出厂默认，避免判官拿不到 system。 */
  const pickPrompt = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value : fallback)

  /**
   * 活设置里的 `judge.maxTokens` 怎么落到 live 上。
   *  - 活设置有数字 → 那个数字（逃生舱，面板已不再暴露这个框）；
   *  - 否则 mount config 的 `maxTokens` 有数字 → 那个数字（老挂载点里可能还留着 4000，但代码要认它）；
   *  - 两者都没有 / 为 null → undefined＝用 `JUDGE_MAX_TOKENS`（32768）；
   *  - 非法值（越界、不是数字）→ 与老行为一致，回落到 mount 的值。
   * v1.4.0：上界从 8000 提到 32768，别再把老配置里合法的大值当非法丢掉。
   */
  const pickBudget = (value, fallback) => {
    if (value === null || value === undefined) return typeof fallback === 'number' ? fallback : undefined
    return pickInt(value, fallback, 64, JUDGE_MAX_TOKENS)
  }

  /** 文件没变就不重复解析（每轮都会走这里）。 */
  let liveCache = { key: '', value: null }

  /**
   * 读「活设置」。面板写的就是这个文件，人也能手改，所以每轮现读一次（mtime+size 做缓存）。
   * 读不到/读不懂一律返回 null → 调用方退回 patch 里的静态配置（fail-open，绝不因为读文件失败而不查或卡住）。
   */
  const readLive = () => {
    if (settings.settingsFile === '') return null
    let stat
    try {
      stat = statSync(settings.settingsFile)
    } catch {
      return null
    }
    const key = `${stat.mtimeMs}:${stat.size}`
    if (liveCache.key === key && liveCache.value !== null) return liveCache.value
    try {
      const parsed = JSON.parse(readFileSync(settings.settingsFile, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      const triggers = typeof parsed.triggers === 'object' && parsed.triggers !== null ? parsed.triggers : {}
      const judge = typeof parsed.judge === 'object' && parsed.judge !== null ? parsed.judge : {}
      const rawModel = judge.model
      const model =
        rawModel &&
        typeof rawModel.provider === 'string' &&
        rawModel.provider !== '' &&
        typeof rawModel.model === 'string' &&
        rawModel.model !== ''
          ? { provider: rawModel.provider, model: rawModel.model }
          : undefined
      const value = {
        enabled: pickBool(parsed.enabled, settings.enabled),
        dryRun: pickBool(parsed.dryRun, settings.dryRun),
        maxReworks: pickInt(triggers.maxReworks, settings.maxReworks, 0, 10),
        minReplyChars: pickInt(triggers.minReplyChars, settings.minReplyChars, 0, 20000),
        scoreThreshold: pickInt(triggers.scoreThreshold, settings.scoreThreshold, 0, 100),
        timeoutMs: pickInt(judge.timeoutMs, settings.timeoutMs, 1000, 120000),
        maxTokens: pickBudget(judge.maxTokens, settings.maxTokens),
        onUnknown: parsed.onUnknown === 'rework' ? 'rework' : parsed.onUnknown === 'pass' ? 'pass' : settings.onUnknown,
        /**
         * 面板把这一项写在**顶层** `reasoningEffort`（和 `onUnknown` 一样），
         * 早期版本读的是 `judge.reasoningEffort`——两处都认，别让面板改了引擎看不见。
         */
        reasoningEffort: (() => {
          const value = typeof parsed.reasoningEffort === 'string' ? parsed.reasoningEffort : judge.reasoningEffort
          if (typeof value !== 'string') return settings.reasoningEffort
          // 旧值 `auto` 与旧审计里的缺省都收敛到 `default`（＝不发档位）。
          if (value === 'auto') return 'default'
          return value === 'default' || EFFORTS.includes(value) ? value : settings.reasoningEffort
        })(),
        model: model ?? settings.model,
        auditFile: typeof parsed.auditFile === 'string' ? parsed.auditFile : settings.auditFile,
        judgeSystem: pickPrompt(parsed.judgeSystem, DEFAULT_JUDGE_SYSTEM),
        judgeRules: pickPrompt(parsed.judgeRules, DEFAULT_JUDGE_RULES),
        ...(() => {
          if (!Array.isArray(parsed.criteria)) return { criteria: criteriaText(), criteriaLabels: [] }
          const composed = composeLiveCriteria(parsed.criteria, parsed.exceptions)
          return { criteria: composed.text, criteriaLabels: composed.labels }
        })(),
      }
      liveCache = { key, value }
      return value
    } catch (error) {
      warnOnce(`${name}: cannot read settings file ${settings.settingsFile}: ${String((error && error.message) || error)}`)
      return null
    }
  }

  /** 这一轮真正生效的设置：活设置优先，没有就退回 patch。 */
  const liveNow = () => {
    const fromFile = readLive()
    if (fromFile !== null) return fromFile
    return { ...settings, criteria: criteriaText(), criteriaLabels: [], judgeSystem: DEFAULT_JUDGE_SYSTEM, judgeRules: DEFAULT_JUDGE_RULES }
  }

  // ── v1.3.1：跨轮记住「这个路由不认档位」，别再每轮白撞一次 ──────────────
  /**
   * `effortState` 目前只在一次检查里有效（两个槽共用）。但「provider/model 不支持 reasoning effort」
   * 是**路由级**的事实，不随轮次变：实测 `raccoon/sn-deepseek-v4-1-flash-1017` 对 `low` 直接拒，
   * 每轮都白撞一次 = 每轮多一次上游调用、判官还多白等 0ms~几秒。
   * 这里按 `provider/model` 记一条进程内黑名单：撞过一次之后，同一路由直接不带档位。
   * 只记「明确说了不支持档位」的，真错误（502/超时）不进这张表。
   */
  const effortRefused = new Map()
  const routeKey = (route) => `${route.provider}/${route.model}`
  const effortStateFor = (route) => ({ unsupported: effortRefused.get(routeKey(route)) === true })
  const rememberRefusal = (route) => {
    const key = routeKey(route)
    if (effortRefused.get(key) === true) return
    effortRefused.set(key, true)
    try {
      ctx.logger?.warn?.(`${name}: ${key} does not accept a reasoning-effort level; will judge without one from now on`)
    } catch {
      // 吞掉。
    }
  }

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    const live = liveNow()
    if (live.enabled === false) return
    let entry
    try {
      const session = agent?.session
      if (session === undefined) return
      entry = bucket(session.id, turn)
      if (entry.reworks >= live.maxReworks) return

      const exchange = lastExchange(session)
      if (exchange === undefined) return
      if (exchange.reply.length < live.minReplyChars) return

      const llm = llmService ?? (() => {
        try {
          return ctx.get?.('llm')
        } catch {
          return undefined
        }
      })()
      if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
        warnOnce(`${name}: no llm service in this composition — semantic self-check is off`)
        return
      }

      const route = live.model ?? lastRoute(session)
      if (route === undefined) {
        warnOnce(`${name}: no model route for this session — semantic self-check is off`)
        return
      }

      /**
       * v1.4.0 判法，两级：
       *  1. **逐条打分**（判据里有编号条目时）：每条判据各拿一个 0-10 分，分数由程序折算。
       *     实测总分极差 good 8 / mid 6 / bad 5，而「给个 0-100」是 range 54。
       *  2. 拿不到得分就补判一次：提示压得更短（只要那一行得分、问题与回复都截一半）；
       *     判据里没有编号条目时，两级都退回老的 `SCORE:` 问法。
       * v5 的三值逻辑保留：unknown 不是「放行」的同义词，得先尽力把它变成 pass/fail。
       *
       * v1.4.0：**两个槽不再换档**。槽 2 只是「同样的参数、更短的提示」再问一次——
       * 生产数据说升档那一半从来没救回过东西（`attempts=2` 7 行、成功 0 行，全是被 provider 拒绝的 medium）。
       * 用户拍板：「这样换挡，重想通通没有」。plan 里现在只有预算一项，两槽完全一样。
       */
      const items = checklistItems(live.criteria, live.criteriaLabels)
      const effortState = effortStateFor(route)
      const plan = { effort: effortToSend(live), ...slotBudget(live) }
      /**
       * 一个槽的判定：有编号条目就逐条打分（`brief` 时压得更短），
       * 没有编号条目就退回只问总分的旧提示。
       */
      const judgeSlot = (brief) => {
        if (items.length > 0) {
          return runJudge(
            llm,
            route,
            scoreItemsPrompt(exchange.question, exchange.reply, live.criteria, items, brief, live.judgeRules),
            live,
            (text) => scoreVerdict(text, items, live.scoreThreshold),
            effortState,
            plan,
          )
        }
        const prompt = brief
          ? scorePrompt(exchange.question, exchange.reply, live.criteria)
          : judgePrompt(exchange.question, exchange.reply, live.criteria)
        return runJudge(llm, route, prompt, live, parseVerdict, effortState, plan)
      }
      let verdict
      let judgeError
      let attempts = 0
      try {
        attempts = 1
        verdict = await judgeSlot(false)
      } catch (error) {
        judgeError = error
      }
      if (verdict === undefined) {
        attempts = 2
        try {
          verdict = await judgeSlot(true)
          judgeError = undefined
        } catch (error) {
          judgeError = error
        }
      }
      const retried = attempts === 2
      // 这一轮撞过「路由不认档位」就记下来，下一轮同路由直接不带档位（见 effortRefused 的注释）。
      if (effortState.unsupported === true) rememberRefusal(route)

      const base = {
        turn,
        session: session.id,
        rework: entry.reworks,
        dryRun: live.dryRun,
        route: `${route.provider}/${route.model}`,
        chars: exchange.reply.length,
        retried,
        attempts,
      }

      // ── UNKNOWN 出口 ────────────────────────────────────────────────
      if (verdict === undefined) {
        const reason = String((judgeError && judgeError.message) || judgeError)
        const meta = judgeError?.judge ?? {}
        const rework = live.onUnknown === 'rework'
        audit({ ...base, decision: 'unknown', onUnknown: live.onUnknown, error: reason, ...meta }, live.auditFile)
        if (!rework) {
          try {
            ctx.logger?.warn?.(
              `${name}: judge gave no usable verdict, letting the turn close (onUnknown=pass, retried=${retried}): ${reason}`,
            )
          } catch {
            // 吞掉。
          }
          return
        }
        if (live.dryRun) {
          try {
            ctx.logger?.warn?.(`${name}: [dry-run] would rework on unknown: ${reason}`)
          } catch {
            // 吞掉。
          }
          return
        }
        entry.reworks += 1
        agent.steer({
          id: `selfcheck-guard-${session.id}-${turn}-${entry.reworks}`,
          role: 'user',
          content: [{ type: 'text', text: noticeUnknown(entry.reworks, live.maxReworks) }],
          source: GUARD_SOURCE,
        })
        return
      }

      // ── 拿到裁定：分数优先，verdict 兜底 ─────────────────────────────
      // score 可能是 undefined（判官只说了 fail 没给数字）：那就按 verdict 判。
      const failed =
        verdict.verdict === 'fail' ||
        (verdict.score !== undefined && verdict.score < live.scoreThreshold)
      const decision = failed ? 'fail' : 'pass'
      audit(
        {
          ...base,
          score: verdict.score,
          verdict: verdict.verdict,
          decision,
          scoreSource: verdict.scoreSource,
          failed,
          checks: verdict.checks,
          incomplete: verdict.incomplete,
          effort: verdict.effort,
          maxTokens: verdict.maxTokens,
          maxTokensAuto: verdict.maxTokensAuto,
          worst: verdict.worst,
          fix: verdict.fix,
          finish: verdict.finish,
          judgeMs: verdict.judgeMs,
          textChars: verdict.textChars,
          reasonChars: verdict.reasonChars,
          textSource: verdict.textSource,
        },
        live.auditFile,
      )
      if (!failed) return

      if (live.dryRun) {
        try {
          ctx.logger?.warn?.(
            `${name}: [dry-run] would rework (score=${verdict.score}) worst=${verdict.worst} fix=${verdict.fix}`,
          )
        } catch {
          // 日志失败不影响会话。
        }
        return
      }

      entry.reworks += 1
      agent.steer({
        id: `selfcheck-guard-${session.id}-${turn}-${entry.reworks}`,
        role: 'user',
        content: [{ type: 'text', text: notice(verdict, entry.reworks, live.maxReworks) }],
        source: GUARD_SOURCE,
      })
    } catch (error) {
      // 一个质检器不该弄坏会话：放行，只留一行日志。
      const reason = String((error && error.message) || error)
      audit({ turn, decision: 'unknown', error: reason, ...(error?.judge ?? {}) }, live.auditFile)
      try {
        ctx.logger?.warn?.(`${name}: check failed, letting the turn close: ${reason}`)
      } catch {
        // 吞掉。
      }
    }
  })
}

export default apply
