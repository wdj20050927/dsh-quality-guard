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
 *     仍拿不到就按 `onUnknown` 处置（默认 `pass`，可设 `rework`）。unknown 一律写进审计，可回查。
 *  出处：anthropics/claude-cookbooks `capabilities/content_moderation/engine.py` 的
 *  「Any unknown that would matter yields decision `needs_review` rather than a confident verdict」。
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
  'auditFile',
  'criteriaFile',
  'settingsFile',
  'model',
])

/** 本插件注入消息的 source.kind，用于自我识别（不会被当成用户说的话）。 */
const GUARD_SOURCE = { kind: 'plugin:selfcheck-guard' }

/** 判官的系统提示：只判表达与命中，不判内容对错。 */
const JUDGE_SYSTEM = [
  '你是一个苛刻的质检员。你面前有「用户的问题」和「助手即将发出的回复」。',
  '你不评价内容是否正确、是否充分，只判定这段回复**读起来是否符合用户的阅读要求**。',
  '宁可判不合格，也不要放过一整段铺垫、背景、旁支。',
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
    question === undefined ? '（这一轮没有找到用户的原话，只判定表达是否直白、是否旁生枝节；第 1、5 条按不适用处理）' : clip(question, 1500),
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
 */
async function runJudge(llm, route, promptText, settings) {
  const controller = new AbortController()
  const started = Date.now()
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
  let text = ''
  let reasoning = ''
  let finish
  const meta = () => ({
    judgeMs: Date.now() - started,
    finish: finishLabel(finish),
    textChars: text.length,
    reasonChars: reasoning.length,
  })
  const fail = (message) => {
    const error = new Error(message)
    error.judge = meta()
    return error
  }
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }],
      maxTokens: settings.maxTokens,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
      else if (chunk?.type === 'finish') finish = chunk.reason
    }
  } finally {
    clearTimeout(timer)
  }
  const info = meta()
  const picked = salvageText(text, reasoning)

  // 先抢救分数：流断了不代表它没给过分。
  let verdict
  let parseError
  try {
    verdict = parseVerdict(picked.text)
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
    throw fail(`judge aborted after ${info.judgeMs}ms (timeoutMs=${settings.timeoutMs})`)
  }
  if (picked.text.trim() === '') {
    throw fail(
      `judge produced no text (finish=${info.finish}, ${info.judgeMs}ms, reasonChars=${info.reasonChars}, maxTokens=${settings.maxTokens})`,
    )
  }
  throw fail(
    `${String((parseError && parseError.message) || parseError)} [finish=${info.finish}, ${info.judgeMs}ms, textChars=${info.textChars}, reasonChars=${info.reasonChars}]`,
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
    question === undefined ? '（未找到，第 1、5 条按不适用处理）' : clip(question, 800),
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
  ]
  return lines.filter((line) => line !== '').join('\n')
}

/** 三值裁定里 unknown 落到 rework 时的文案（不带分数，因为真没有分数）。 */
function noticeUnknown(attempt, maxReworks) {
  return [
    `【质检未过·判官这一轮没给出可用的判定·已被打回第 ${attempt}/${maxReworks} 轮】`,
    '按用户的要求重写这条回复：最核心的那一点先说，用最直白的话讲；删掉铺垫、背景、他没问的旁支；数值和文献出处一条不少。',
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
  const settings = {
    enabled: bool('enabled', true),
    dryRun: bool('dryRun', true),
    maxReworks: int('maxReworks', 3, 0),
    timeoutMs: int('timeoutMs', 60000, 1000),
    maxTokens: int('maxTokens', 4000, 64),
    minReplyChars: int('minReplyChars', 0, 0),
    scoreThreshold: int('scoreThreshold', 70, 0),
    onUnknown: 'pass',
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
   */
  const composeLiveCriteria = (list, exceptions) => {
    const lines = ['判据（任一条不满足即不合格）：']
    let index = 0
    for (const item of list) {
      if (!item || item.enabled === false) continue
      const text = typeof item.text === 'string' ? item.text.trim() : ''
      if (text === '') continue
      index += 1
      lines.push(`${index}. ${text}`)
    }
    if (index === 0) return CRITERIA
    const extras = typeof exceptions === 'string' ? exceptions.trim() : ''
    if (extras !== '') {
      lines.push('')
      lines.push('例外：')
      for (const line of extras.split(/\r?\n/)) {
        if (line.trim() !== '') lines.push(`- ${line.trim()}`)
      }
    }
    return lines.join('\n')
  }

  const pickInt = (value, fallback, min, max) => {
    const number = Number(value)
    if (!Number.isInteger(number) || number < min || number > max) return fallback
    return number
  }
  const pickBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

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
        maxTokens: pickInt(judge.maxTokens, settings.maxTokens, 64, 8000),
        onUnknown: parsed.onUnknown === 'rework' ? 'rework' : parsed.onUnknown === 'pass' ? 'pass' : settings.onUnknown,
        model: model ?? settings.model,
        auditFile: typeof parsed.auditFile === 'string' ? parsed.auditFile : settings.auditFile,
        criteria: Array.isArray(parsed.criteria)
          ? composeLiveCriteria(parsed.criteria, parsed.exceptions)
          : criteriaText(),
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
    return { ...settings, criteria: criteriaText() }
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
       * 判一次；拿不到分数就**换更便宜的提示补判一次**（只要一行 SCORE）。
       * v5 的三值逻辑：unknown 不是「放行」的同义词，得先尽力把它变成 pass/fail。
       */
      let verdict
      let judgeError
      let retried = false
      try {
        verdict = await runJudge(llm, route, judgePrompt(exchange.question, exchange.reply, live.criteria), live)
      } catch (error) {
        judgeError = error
      }
      if (verdict === undefined) {
        retried = true
        try {
          verdict = await runJudge(llm, route, scorePrompt(exchange.question, exchange.reply, live.criteria), live)
          judgeError = undefined
        } catch (error) {
          judgeError = error
        }
      }

      const base = {
        turn,
        session: session.id,
        rework: entry.reworks,
        dryRun: live.dryRun,
        route: `${route.provider}/${route.model}`,
        chars: exchange.reply.length,
        retried,
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
