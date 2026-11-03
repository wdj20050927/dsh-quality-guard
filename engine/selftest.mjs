/**
 * selfcheck-guard 的离线自测：不需要真 DSH，也不需要真模型。
 *
 * 跑法（PATH 上没有 node，用 runtime 自带的那个）：
 *   node selftest.mjs
 */

import fs from 'node:fs'
import { apply, name, JUDGE_MAX_TOKENS, AUTO_START } from './index.mjs'

let passed = 0
let failed = 0
const check = (label, ok, detail) => {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** 造一条 assistant 消息事件（不带 tool-call＝这就是「回复」）。 */
const replyEvent = (text) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

/** 造一条带工具调用的 assistant 消息（中间说明，不算回复）。 */
const toolEvent = (text) => ({
  type: 'assistant/message',
  data: {
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text },
        { type: 'tool-call', name: 'read', arguments: '{}' },
      ],
    },
  },
})

const userEvent = (text, kind = 'user') => ({
  type: 'user/message',
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind } },
})

const routeEvent = (provider = 'deepseek', model = 'deepseek-chat') => ({
  type: 'request/header',
  data: { header: { config: { provider, model } } },
})

/** 假 llm：按给定输出回一串 text-delta，可指定抛错。 */
function fakeLlm(behaviour) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      const chunks = []
      const reply = typeof behaviour === 'function' ? behaviour(options) : behaviour
      if (reply instanceof Error) {
        return (async function* () {
          throw reply
        })()
      }
      const text = typeof reply === 'string' ? reply : JSON.stringify(reply)
      chunks.push({ type: 'block-start', index: 0, blockType: 'text' })
      for (let i = 0; i < text.length; i += 40) {
        chunks.push({ type: 'text-delta', index: 0, text: text.slice(i, i + 40) })
      }
      chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
      chunks.push({ type: 'finish', reason: { kind: 'stop' } })
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

/** 假 llm：完全自己给 chunk（用来演 reasoning 通道、aborted、max-tokens）。 */
function fakeLlmChunks(chunks) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

/** 一段「话全在推理通道里」的流（v4 前会被当成判官空手）。 */
const reasoningChunks = (text, reason = { kind: 'stop' }) => [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
  { type: 'finish', reason },
]

/** 读一行审计（JSONL 最后一行）。 */
const lastAuditRow = (file) => {
  const rows = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
  return JSON.parse(rows[rows.length - 1])
}

const tmpFile = (suffix) => `${process.env.TEMP ?? '/tmp'}/selfcheck-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`

/** 造一个最小 ctx + agent，把 turn-stopping 的 handler 抓出来直接调。 */
function harness(config, llm, events) {
  const handlers = {}
  const warned = []
  const steered = []
  const ctx = {
    on(event, handler) {
      ;(handlers[event] ??= []).push(handler)
      return () => {}
    },
    inject(_deps, callback) {
      callback({ get: (key) => (key === 'llm' ? llm : undefined) })
    },
    get(key) {
      return key === 'llm' ? llm : undefined
    },
    logger: {
      warn(text) {
        warned.push(text)
      },
      info() {},
    },
  }
  apply(ctx, config)
  const session = { id: 'sess-1', snapshotEvents: () => events }
  const agent = {
    session,
    steer(message) {
      steered.push(message)
    },
  }
  const stop = async (turn = 1) => {
    for (const handler of handlers['agent/turn-stopping'] ?? []) await handler({ agent, turn })
  }
  return { stop, steered, warned, llm }
}

const FAIL_VERDICT = { score: 35, verdict: 'fail', worst: '先铺了三段背景', fix: '第一句直接给结论' }
const PASS_VERDICT = { score: 92, verdict: 'pass', worst: '', fix: '' }

const baseEvents = [userEvent('这东西怎么改？'), routeEvent(), replyEvent('很长很长的铺垫……')]

console.log(`${name} selftest`)

// 1. 判官放行 → 不回炉
{
  const h = harness({ dryRun: false }, fakeLlm(PASS_VERDICT), baseEvents)
  await h.stop()
  check('pass 判定不回炉', h.steered.length === 0, `steered=${h.steered.length}`)
}

// 2. 判官判不合格 + dryRun → 只记日志
{
  const h = harness({ dryRun: true }, fakeLlm(FAIL_VERDICT), baseEvents)
  await h.stop()
  check('dry-run 不拦截', h.steered.length === 0)
  check('dry-run 留了日志', h.warned.some((line) => line.includes('[dry-run]')), h.warned.join(' | '))
}

// 3. 判官判不合格 + 非 dryRun → 真的 steer 一次，且 source.kind 正确
{
  const h = harness({ dryRun: false }, fakeLlm(FAIL_VERDICT), baseEvents)
  await h.stop()
  check('fail 真回炉一次', h.steered.length === 1, `steered=${h.steered.length}`)
  const message = h.steered[0]
  check('注入消息 source.kind 正确', message?.source?.kind === 'plugin:selfcheck-guard', JSON.stringify(message?.source))
  check('注入消息带分数', String(message?.content?.[0]?.text ?? '').includes('35 分'))
  check('注入消息带改法', String(message?.content?.[0]?.text ?? '').includes('第一句直接给结论'))
}

// 4. 同一 turn 第二次 stopping 不再回炉（maxReworks 显式设 1）
{
  const h = harness({ dryRun: false, maxReworks: 1 }, fakeLlm(FAIL_VERDICT), baseEvents)
  await h.stop(1)
  await h.stop(1)
  check('同轮不重复回炉（maxReworks=1）', h.steered.length === 1, `steered=${h.steered.length}`)
}

// 4b. 默认最多打回 3 轮，且文案写明第几轮
{
  const h = harness({ dryRun: false }, fakeLlm(FAIL_VERDICT), baseEvents)
  await h.stop(1)
  await h.stop(1)
  await h.stop(1)
  await h.stop(1)
  check('默认最多打回 3 轮', h.steered.length === 3, `steered=${h.steered.length}`)
  const last = String(h.steered[2]?.content?.[0]?.text ?? '')
  check('打回文案写第几轮', last.includes('第 3/3 轮'), last.slice(0, 40))
}

// 5. 不同 turn 各算一次
{
  const h = harness({ dryRun: false }, fakeLlm(FAIL_VERDICT), baseEvents)
  await h.stop(1)
  await h.stop(2)
  check('跨轮各自计数', h.steered.length === 2, `steered=${h.steered.length}`)
}

// 6. 只有工具调用、没有回复 → 不调判官
{
  const llm = fakeLlm(FAIL_VERDICT)
  const h = harness({ dryRun: false }, llm, [userEvent('干活'), routeEvent(), toolEvent('我看看文件')])
  await h.stop()
  check('没有文本回复不判', llm.calls.length === 0, `calls=${llm.calls.length}`)
  check('没有文本回复不回炉', h.steered.length === 0)
}

// 7. 判官调用抛错 → 补判一次仍失败则放行，不弄坏会话
// （v7 起 onUnknown 默认是 rework，这条测的是「显式选择放行」这条路径，所以要显式传 pass）
{
  const h = harness({ dryRun: false, onUnknown: 'pass' }, fakeLlm(new Error('upstream 502')), baseEvents)
  await h.stop()
  check('判官抛错则放行', h.steered.length === 0)
  check('判官抛错留了日志', h.warned.some((line) => line.includes('letting the turn close')), h.warned.join(' | '))
}

// 8. 判官返回非 JSON 也非分数 → 补判一次，仍拿不到就放行（v5：unknown 出口；显式 onUnknown=pass）
{
  const llm = fakeLlm('我觉得还行吧')
  const h = harness({ dryRun: false, onUnknown: 'pass' }, llm, baseEvents)
  await h.stop()
  check('非法输出则放行', h.steered.length === 0)
  check('非法输出会补判一次', llm.calls.length === 2, `calls=${llm.calls.length}`)
  check('补判的提示是更短的一行版', String(llm.calls[1]?.messages?.[0]?.content?.[0]?.text ?? '').includes('只输出这一行得分'))
}

// 9. 没有路由 → 不调用，只 warn 一次
{
  const llm = fakeLlm(FAIL_VERDICT)
  const h = harness({ dryRun: false }, llm, [userEvent('问'), replyEvent('答')])
  await h.stop()
  await h.stop(2)
  check('没有路由就不调判官', llm.calls.length === 0, `calls=${llm.calls.length}`)
  check('没有路由只 warn 一次', h.warned.filter((line) => line.includes('no model route')).length === 1)
}

// 10. 显式配置 model 时不需要 request/header
{
  const llm = fakeLlm(PASS_VERDICT)
  const h = harness({ dryRun: false, model: { provider: 'p', model: 'm' } }, llm, [userEvent('问'), replyEvent('答')])
  await h.stop()
  check('显式 model 可用', llm.calls.length === 1, `calls=${llm.calls.length}`)
  check('用了配置里的路由', llm.calls[0]?.provider === 'p' && llm.calls[0]?.model === 'm')
}

// 11. 分数是字符串 "55" → 按不合格处理
{
  const h = harness({ dryRun: false }, fakeLlm({ score: '55', verdict: 'pass' }), baseEvents)
  await h.stop()
  check('字符串分数也认', h.steered.length === 1, `steered=${h.steered.length}`)
}

// 12. enabled=false 完全不动
{
  const llm = fakeLlm(FAIL_VERDICT)
  const h = harness({ enabled: false }, llm, baseEvents)
  await h.stop()
  check('enabled=false 不调用', llm.calls.length === 0)
}

// 13. 未知配置键当场报错
{
  let threw
  try {
    harness({ maxChars: 800 }, fakeLlm(PASS_VERDICT), baseEvents)
  } catch (error) {
    threw = error
  }
  check('未知配置键报错', threw instanceof TypeError && String(threw.message).includes('maxChars'))
}

// 14. 非法配置值当场报错
{
  let threw
  try {
    harness({ maxReworks: -1 }, fakeLlm(PASS_VERDICT), baseEvents)
  } catch (error) {
    threw = error
  }
  check('非法 maxReworks 报错', threw instanceof TypeError)
}

// 15. 判官 prompt 里同时带了用户的问题和回复
{
  const llm = fakeLlm(PASS_VERDICT)
  const h = harness({ dryRun: false }, llm, baseEvents)
  await h.stop()
  const prompt = llm.calls[0]?.messages?.[0]?.content?.[0]?.text ?? ''
  check('prompt 带原问题', prompt.includes('这东西怎么改？'))
  check('prompt 带待检回复', prompt.includes('很长很长的铺垫'))
  check('prompt 带判据 4（出处不能省）', prompt.includes('该带的出处一条不少'))
}

// 16. 判据来自外部 md 文件（用户自己写的那份）
{
  const path = `${process.env.TEMP ?? '/tmp'}/selfcheck-criteria-${Date.now()}.md`
  fs.writeFileSync(path, '1. 我是用户自己写的判据 MARKER-XYZ\n', 'utf8')
  const llm = fakeLlm(PASS_VERDICT)
  const h = harness({ dryRun: false, criteriaFile: path }, llm, baseEvents)
  await h.stop()
  const prompt = llm.calls[0]?.messages?.[0]?.content?.[0]?.text ?? ''
  check('用外部判据文件', prompt.includes('MARKER-XYZ'), prompt.slice(0, 40))
  check('外部判据时不再带内置判据', !prompt.includes('该带的出处一条不少'))
  fs.unlinkSync(path)
}

// 17. 判据文件读不到 → 退回内置判据，不乱来
{
  const llm = fakeLlm(PASS_VERDICT)
  const h = harness({ dryRun: false, criteriaFile: 'C:/definitely/not/here.md' }, llm, baseEvents)
  await h.stop()
  const prompt = llm.calls[0]?.messages?.[0]?.content?.[0]?.text ?? ''
  check('判据文件缺失则退回内置', prompt.includes('该带的出处一条不少'))
}

// 18. 文本全在 reasoning 通道（v4 的坑）→ 从推理里捞 JSON 照判
{
  const audit = tmpFile('audit-reason')
  const h = harness(
    { dryRun: false, auditFile: audit },
    fakeLlmChunks(reasoningChunks(JSON.stringify(FAIL_VERDICT))),
    baseEvents,
  )
  await h.stop()
  check('reasoning 里的 JSON 也能判', h.steered.length === 1, `steered=${h.steered.length}`)
  const row = lastAuditRow(audit)
  check('审计记下 textSource=reasoning', row.textSource === 'reasoning', JSON.stringify(row))
  check('审计记下 reasonChars', row.reasonChars > 0, JSON.stringify(row))
  fs.unlinkSync(audit)
}

// 19. finish=aborted（超时 abort）→ 显式超时，不回炉，审计能看出原因
{
  const audit = tmpFile('audit-aborted')
  const h = harness(
    { dryRun: false, auditFile: audit, onUnknown: 'pass' },
    fakeLlmChunks([{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }]),
    baseEvents,
  )
  await h.stop()
  check('aborted 不回炉', h.steered.length === 0, `steered=${h.steered.length}`)
  const row = lastAuditRow(audit)
  check('aborted 写进审计', row.finish === 'aborted', JSON.stringify(row))
  check('aborted 审计带耗时', Number.isFinite(row.judgeMs), JSON.stringify(row))
  check('aborted 报的是超时', String(row.error ?? '').includes('judge aborted after'), JSON.stringify(row))
  fs.unlinkSync(audit)
}

// 20. finish=max-tokens 且一个字都没有 → 报「没产出文本」，不静默
{
  const audit = tmpFile('audit-maxtokens')
  const h = harness(
    { dryRun: false, auditFile: audit, onUnknown: 'pass' },
    fakeLlmChunks([{ type: 'finish', reason: { kind: 'max-tokens' } }]),
    baseEvents,
  )
  await h.stop()
  check('maxTokens 吃光不回炉', h.steered.length === 0, `steered=${h.steered.length}`)
  const row = lastAuditRow(audit)
  check('maxTokens 写进审计', row.finish === 'max-tokens', JSON.stringify(row))
  check('maxTokens 报的是没文本', String(row.error ?? '').includes('produced no text'), JSON.stringify(row))
  fs.unlinkSync(audit)
}

// 21. 正常判分也带诊断字段（finish / judgeMs / textChars / reasonChars / textSource）
{
  const audit = tmpFile('audit-ok')
  const h = harness({ dryRun: false, auditFile: audit }, fakeLlm(PASS_VERDICT), baseEvents)
  await h.stop()
  const row = lastAuditRow(audit)
  check('正常判分记 finish=stop', row.finish === 'stop', JSON.stringify(row))
  check('正常判分记 textSource=text', row.textSource === 'text', JSON.stringify(row))
  check('正常判分记长度与耗时', row.textChars > 0 && Number.isFinite(row.judgeMs), JSON.stringify(row))
  fs.unlinkSync(audit)
}

// 22. v5：行式输出（分数第一行）能判，且审计记 scoreSource=lines
{
  const audit = tmpFile('audit-lines')
  const h = harness(
    { dryRun: false, auditFile: audit },
    fakeLlm('SCORE: 30\nVERDICT: fail\nWORST: 先铺背景\nFIX: 结论前置'),
    baseEvents,
  )
  await h.stop()
  check('行式输出能判', h.steered.length === 1, `steered=${h.steered.length}`)
  const row = lastAuditRow(audit)
  check('审计记 scoreSource=lines', row.scoreSource === 'lines', JSON.stringify(row))
  check('行式输出带上了 worst', row.worst === '先铺背景', JSON.stringify(row))
  fs.unlinkSync(audit)
}

// 23. v5 核心：半截 JSON 里有分数 → 抢救出来按分数判，不再放行
{
  const audit = tmpFile('audit-truncated')
  const h = harness(
    { dryRun: false, auditFile: audit },
    fakeLlm('{"score": 42, "verdict": "fail", "worst": "先铺了三段背'),
    baseEvents,
  )
  await h.stop()
  check('半截 JSON 也按分数打回', h.steered.length === 1, `steered=${h.steered.length}`)
  const row = lastAuditRow(audit)
  check('半截 JSON 记 scoreSource=salvage', row.scoreSource === 'salvage', JSON.stringify(row))
  check('半截 JSON 分数是 42', row.score === 42, JSON.stringify(row))
  check('半截 JSON 判为 fail', row.decision === 'fail', JSON.stringify(row))
  fs.unlinkSync(audit)
}

// 24. v5 核心：分数已吐出来才 max-tokens 断流 → 照样按分数判，不当作「没产出」
{
  const audit = tmpFile('audit-trunc-score')
  const h = harness(
    { dryRun: false, auditFile: audit },
    fakeLlmChunks([
      { type: 'text-delta', index: 0, text: 'SCORE: 25\nVERDICT: fail\nWORST: 全是铺垫' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]),
    baseEvents,
  )
  await h.stop()
  check('断流但有分数就按分数判', h.steered.length === 1, `steered=${h.steered.length}`)
  const row = lastAuditRow(audit)
  check('断流判分记 finish=max-tokens', row.finish === 'max-tokens', JSON.stringify(row))
  check('断流判分没有 error 字段', row.error === undefined, JSON.stringify(row))
  fs.unlinkSync(audit)
}

// 25. v5：第一次拿不到分数，补判拿到分数 → 按补判的分数判
{
  const audit = tmpFile('audit-retry')
  let call = 0
  const llm = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      call += 1
      const body = call === 1 ? '我先想想……' : 'SCORE: 20'
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: body }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const h = harness({ dryRun: false, auditFile: audit }, llm, baseEvents)
  await h.stop()
  check('补判拿到分数就回炉', h.steered.length === 1, `steered=${h.steered.length}`)
  const row = lastAuditRow(audit)
  check('审计记 retried=true', row.retried === true, JSON.stringify(row))
  check('补判分数是 20', row.score === 20, JSON.stringify(row))
  fs.unlinkSync(audit)
}

// 26. v7：onUnknown 默认变成 rework —— 两次都拿不到裁定就打回，审计留 decision=unknown
{
  const audit = tmpFile('audit-unknown')
  const h = harness({ dryRun: false, auditFile: audit }, fakeLlm('我不知道'), baseEvents)
  await h.stop()
  check('unknown 默认打回（v7 默认 rework）', h.steered.length === 1, `steered=${h.steered.length}`)
  const row = lastAuditRow(audit)
  check('unknown 写进审计', row.decision === 'unknown', JSON.stringify(row))
  check('unknown 审计带原因', String(row.error ?? '').includes('no score'), JSON.stringify(row))
  check('unknown 审计记 onUnknown=rework', row.onUnknown === 'rework', JSON.stringify(row))
  check('unknown 审计记 attempts=2', row.attempts === 2, JSON.stringify(row))
  check('unknown 审计记实际 maxTokens', Number.isFinite(row.maxTokens), JSON.stringify(row))
  fs.unlinkSync(audit)
}

// 27. v5：onUnknown=rework 时 unknown 真的打回
{
  const h = harness({ dryRun: false, onUnknown: 'rework' }, fakeLlm('我不知道'), baseEvents)
  await h.stop()
  check('onUnknown=rework 会打回', h.steered.length === 1, `steered=${h.steered.length}`)
  check('unknown 打回文案不说分数', String(h.steered[0]?.content?.[0]?.text ?? '').includes('没给出可用的判定'))
}

// 28. v5：onUnknown 只接受 pass / rework
{
  let threw
  try {
    harness({ onUnknown: 'ignore' }, fakeLlm(PASS_VERDICT), baseEvents)
  } catch (error) {
    threw = error
  }
  check('非法 onUnknown 报错', threw instanceof TypeError && String(threw.message).includes('onUnknown'))
}

// 29. v5：分数够高但 verdict=fail（判官自相矛盾）→ 以 fail 为准，宁严不宽
{
  const audit = tmpFile('audit-conflict')
  const h = harness({ dryRun: false, auditFile: audit }, fakeLlm({ score: 88, verdict: 'fail', worst: '答偏了' }), baseEvents)
  await h.stop()
  check('明确 fail 就回炉（即使分数高）', h.steered.length === 1, `steered=${h.steered.length}`)
  fs.unlinkSync(audit)
}

// 30. v5：分数够低但 verdict=pass → 以分数为准打回
{
  const h = harness({ dryRun: false }, fakeLlm({ score: 40, verdict: 'pass' }), baseEvents)
  await h.stop()
  check('分数低于阈值就回炉（即使 verdict=pass）', h.steered.length === 1, `steered=${h.steered.length}`)
}

/**
 * 真实漏判回归集：从生产审计里挖出来的 11 条 `judge returned no JSON`。
 *
 * 这 11 条是 v1.0.1 之前的真实翻车——其中 5 条判官其实已经把分数写出来了
 * （42 / 55 / 55 / 90 / 58），只是 JSON 被截断，旧版 parseVerdict 整条作废、
 * 于是 4 条本该打回的回复被放行。fixtures 文件由 audit.jsonl 原样导出，
 * 跑法见 `engine/fixtures/audit-regressions.json`。
 *
 * 断言的是**行为**而不是实现：给了分数就必须按分数判，没给分数才允许 unknown。
 */
{
  const fixturePath = new URL('./fixtures/audit-regressions.json', import.meta.url)
  const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  let scored = 0
  let unknown = 0
  for (const item of cases) {
    const audit = tmpFile('audit-reg')
    const h = harness({ dryRun: false, auditFile: audit, onUnknown: 'pass' }, fakeLlm(item.judgeOutput), baseEvents)
    await h.stop()
    const row = lastAuditRow(audit)
    if (item.expectedScore === null) {
      // 判官什么都没说出来：补判一次也空 → unknown 出口，默认放行但审计留痕。
      unknown += 1
      check(`${item.id}: 空输出走 unknown 出口`, row.decision === 'unknown', JSON.stringify(row))
      check(`${item.id}: 空输出不静默回炉`, h.steered.length === 0, `steered=${h.steered.length}`)
    } else {
      scored += 1
      check(`${item.id}: 抢救出 ${item.expectedScore} 分`, row.score === item.expectedScore, JSON.stringify(row))
      check(`${item.id}: 按分数判 ${item.expectedScore >= 70 ? 'pass' : 'fail'}`, row.decision === (item.expectedScore >= 70 ? 'pass' : 'fail'), JSON.stringify(row))
      const shouldRework = item.expectedScore < 70
      check(
        `${item.id}: ${shouldRework ? '真的打回了' : '没有误打回'}`,
        h.steered.length === (shouldRework ? 1 : 0),
        `steered=${h.steered.length}`,
      )
    }
    fs.unlinkSync(audit)
  }
  console.log(`  -- 回归集：${cases.length} 条（带分数 ${scored} / 空输出 ${unknown}）`)
}

// 31. v5：判官只说了 fail、没给数字 → 仍然打回（宁可判不合格）
{
  const audit = tmpFile('audit-verdict-only')
  const h = harness({ dryRun: false, auditFile: audit }, fakeLlm('VERDICT: fail\nWORST: 旁支太多'), baseEvents)
  await h.stop()
  check('只说 fail 没分数也打回', h.steered.length === 1, `steered=${h.steered.length}`)
  const row = lastAuditRow(audit)
  check('只给 verdict 时记 scoreSource=verdict-only', row.scoreSource === 'verdict-only', JSON.stringify(row))
  check('只给 verdict 时审计不记 score', row.score === undefined, JSON.stringify(row))
  check('只给 verdict 时判为 fail', row.decision === 'fail', JSON.stringify(row))
  check('打回文案不编造分数', String(h.steered[0]?.content?.[0]?.text ?? '').includes('判官判定不合格'))
  fs.unlinkSync(audit)
}

// 32. v5：判官只说了 pass、没给数字 → 没有依据的放行不接受，走补判后 unknown（显式 onUnknown=pass）
{
  const h = harness({ dryRun: false, onUnknown: 'pass' }, fakeLlm('VERDICT: pass'), baseEvents)
  await h.stop()
  check('只说 pass 没分数不算数', h.steered.length === 0, `steered=${h.steered.length}`)
  check('只说 pass 会触发补判', h.warned.some((line) => line.includes('onUnknown=pass')), h.warned.join(' | '))
}

/**
 * v1.4.0：逐条 0-10 打分模式。
 *
 * 背景（实测，见 `.scratch/probe-judge-*.mjs` 与 `probe-score10-out.txt`）：
 *  - 让判官给「0-100 一个整数」：同一段回复连判 9 次得 40/1/2/20/20/20/30/25/55（range 54），
 *    还会自作主张换成 `SCORE: 2/10`。
 *  - 改成逐条 yes/no：range 0~11，但判据表里「人设」「结论量化打分」这类在技术问答里
 *    根本没有判定对象的条目永远判 no，把本该 100 分的回复压到 60/40/24（audit 358 行实测）。
 *  - 加第三态 na：能修上面的病，但用户否了——「用户随时会去调整质检词，你不知道哪几条要打分、
 *    哪几条要 yes/no」，于是**每条判据都拿一个 0-10 的分**，「客观加不了」写进提示词打 10 分。
 *    实测 good/mid/bad 各 4 次，总分极差 8/6/5，好 76~88、坏 35~42，分得开。
 * 这一组守的就是「逐条打分 + 分母恒等于条数 + 第 1 条硬门槛」这三条规矩。
 */
const SCORE_CRITERIA = [
  '判据（任一条不满足即不合格）：',
  '1. 最核心的那一条放在最前面直接给出。',
  '2. 用最简单最直白的话说。',
  '3. 不旁生枝节。',
].join('\n')

/** 写一份只有 3 条编号判据的临时文件（逐条打分要靠编号才启用）。 */
const checklistCriteriaFile = () => {
  const file = `${process.env.TEMP ?? '/tmp'}/selfcheck-criteria-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
  fs.writeFileSync(file, SCORE_CRITERIA, 'utf8')
  return file
}

const checklistHarness = (llm, config = {}) => {
  const criteriaFile = checklistCriteriaFile()
  const h = harness({ dryRun: false, criteriaFile, ...config }, llm, baseEvents)
  h.cleanup = () => fs.rmSync(criteriaFile, { force: true })
  return h
}

// 33. 逐条打分：全 10 → 100 分 pass，且走的是 scores 分支
{
  const audit = tmpFile('audit-sc-all')
  const h = checklistHarness(fakeLlm('1:10 2:10 3:10\nFIX: 无需改动'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('全 10 分记 100 分', row.score === 100, JSON.stringify(row))
  check('全 10 分判 pass', row.decision === 'pass', JSON.stringify(row))
  check('逐条打分 scoreSource=scores', row.scoreSource === 'scores', JSON.stringify(row))
  check('逐条打分不回炉', h.steered.length === 0, `steered=${h.steered.length}`)
  check(
    'checks 记的是分数而不是 yes/no',
    Array.isArray(row.checks) && row.checks.length === 3 && row.checks[0]?.score === 10 && row.checks[0]?.ok === undefined,
    JSON.stringify(row.checks),
  )
  h.cleanup()
  fs.unlinkSync(audit)
}

// 34. 逐条打分：第 1 条低于 6 分是硬门槛，满分只按 59 折算
//     `1:2 2:10 3:10` → sum=22 → rate=22/30 → round(0.7333*59)=43
{
  const audit = tmpFile('audit-sc-gate')
  const h = checklistHarness(fakeLlm('1:2 2:10 3:10\nFIX: 开头直接给结论'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('第 1 条低于 6 分则按 59 折算（43 分）', row.score === 43, `score=${row.score}`)
  check('第 1 条低于 6 分就判 fail', row.decision === 'fail', JSON.stringify(row))
  check('第 1 条低于 6 分真回炉', h.steered.length === 1, `steered=${h.steered.length}`)
  const steered = String(h.steered[0]?.content?.[0]?.text ?? '')
  check('回炉文案点名是哪一条', steered.includes('最核心的那一条'), steered)
  check('回炉文案带上实际得分', steered.includes('2/10'), steered)
  h.cleanup()
  fs.unlinkSync(audit)
}

// 35. 逐条打分：**任一条**低于 6 分都直接打回（v1.5.0 起，不再只认第 1 条）
//     用户原话：「你现在这个给分太宽泛了，谁都可以踢一脚，怎么行」——
//     五条判据必须条条能一票否决，否则等于五条建议。
//     `1:10 2:5 3:10` → sum=25 → 一条低于 6 → round(25/30*59)=49 分，fail。
{
  const audit = tmpFile('audit-sc-partial')
  const h = checklistHarness(fakeLlm('1:10 2:5 3:10\nFIX: 说人话'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('非第 1 条低于 6 分也按 59 折算（49 分）', row.score === 49, `score=${row.score}`)
  check('非第 1 条低于 6 分也直接打回', row.decision === 'fail', JSON.stringify(row))
  check('失分的条目写进 worst', String(row.worst ?? '').includes('第 2 条'), String(row.worst))
  check('低分就要真回炉', h.steered.length === 1, `steered=${h.steered.length}`)
  h.cleanup()
  fs.unlinkSync(audit)
}

// 35b. 只有「低于 6」才触发一票否决：6 分及以上仍按总分说话
//      `1:10 2:6 3:10` → sum=26 → round(26/30*100)=87 分 pass（6 分是「做到一半」，不是不合格）
{
  const audit = tmpFile('audit-sc-six')
  const h = checklistHarness(fakeLlm('1:10 2:6 3:10'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('6 分不触发否决（87 分）', row.score === 87, `score=${row.score}`)
  check('6 分不触发否决 → pass', row.decision === 'pass', JSON.stringify(row))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 36. 逐条打分：答漏编号时分母恒等于条数（漏答按 0 分压着，不白送分）
//     `1:10 2:10`（漏 3）→ sum=20 → rate=20/30 → 67 分
{
  const audit = tmpFile('audit-sc-missing')
  const h = checklistHarness(fakeLlm('1:10 2:10'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('漏答不让分母变小（67 分）', row.score === 67, `score=${row.score}`)
  check('漏答会记下漏了哪几条', Array.isArray(row.incomplete) && row.incomplete.includes(3), JSON.stringify(row.incomplete))
  check('漏答判 fail', row.decision === 'fail', JSON.stringify(row))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 37. 逐条打分模式：判官改口吐老格式 JSON，也认（要的是裁定，不是格式）
{
  const audit = tmpFile('audit-cl-json')
  const h = harness({ dryRun: false, auditFile: audit }, fakeLlm({ score: 88, verdict: 'pass' }), baseEvents)
  await h.stop()
  const row = lastAuditRow(audit)
  check('逐条打分里老 JSON 也认', row.score === 88, JSON.stringify(row))
  check('逐条打分里老 JSON 记 scoreSource=json', row.scoreSource === 'json', JSON.stringify(row))
  fs.unlinkSync(audit)
}

// 38. 逐条打分模式：判官只吐老格式 `SCORE: 30` 也认
{
  const audit = tmpFile('audit-cl-score')
  const h = harness({ dryRun: false, auditFile: audit }, fakeLlm('SCORE: 30'), baseEvents)
  await h.stop()
  const row = lastAuditRow(audit)
  check('逐条打分里 SCORE 行也认', row.score === 30, JSON.stringify(row))
  check('逐条打分里 SCORE 行判 fail', row.decision === 'fail', JSON.stringify(row))
  fs.unlinkSync(audit)
}

// 39. 逐条打分：提示里必须把编号列出来，且要求一条不漏、分数放第一行
{
  const llm = fakeLlm('1:10 2:10 3:10')
  const h = harness({ dryRun: false }, llm, baseEvents)
  await h.stop()
  const prompt = String(llm.calls[0]?.messages?.[0]?.content?.[0]?.text ?? '')
  check('打分提示带全部编号', prompt.includes('1:8') && prompt.includes('3:10'), prompt.slice(0, 300))
  check('打分提示要求一条不漏', prompt.includes('一条都不许漏'))
  check('打分提示把得分放第一行', prompt.includes('第一行必须是全部得分'))
  check('打分提示带锚点量表', prompt.includes('10 分：完全做到') && prompt.includes('0 分：明确违反'), prompt.slice(0, 300))
  check(
    '打分提示写死「客观加不了→10」',
    prompt.includes('客观加不了') && prompt.includes('这种情况打 **10**'),
    prompt.slice(0, 300),
  )
  check('打分提示禁止第 1 条走客观加不了', prompt.includes('第 1 条永远有判定对象'), prompt.slice(0, 300))
  check('打分提示里的示例第 1 条不是满分（防橡皮图章）', !prompt.includes('例如：1:10'), prompt.slice(-320))
}

// 40. v1.4.0：判官默认**不传** reasoningEffort（v6 的「必须显式传 low」已被生产数据推翻）
//     不传＝继承该 provider/model 自己的默认档，谁是 low / 谁叫别的名字都不会炸。
{
  const llm = fakeLlm('1:10 2:10 3:10')
  const h = harness({ dryRun: false }, llm, baseEvents)
  await h.stop()
  check('判官默认不传 reasoningEffort', llm.calls[0]?.reasoningEffort === undefined, `effort=${llm.calls[0]?.reasoningEffort}`)
}

// 41. v6：reasoningEffort 可配，配成 high 就传 high
{
  const llm = fakeLlm('1:10 2:10 3:10')
  const h = harness({ dryRun: false, reasoningEffort: 'high' }, llm, baseEvents)
  await h.stop()
  check('reasoningEffort 可配成 high', llm.calls[0]?.reasoningEffort === 'high', `effort=${llm.calls[0]?.reasoningEffort}`)
}

// 42. v6：非法 reasoningEffort 当场报错
{
  let threw
  try {
    harness({ reasoningEffort: 'turbo' }, fakeLlm('1:10'), baseEvents)
  } catch (error) {
    threw = error
  }
  check('非法 reasoningEffort 报错', threw instanceof TypeError && String(threw.message).includes('reasoningEffort'), String(threw))
}

// 43. v6：宿主说「不支持这个档位」→ 自动退回不传，绝不让它变成「不查」
{
  let attempt = 0
  const llm = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      attempt += 1
      if (attempt === 1) {
        return (async function* () {
          throw new Error('pi-ai provider "workbuddy" model "x" does not support reasoning effort "low"')
        })()
      }
      const text = '1:10 2:10 3:10'
      return (async function* () {
        for (let i = 0; i < text.length; i += 40) yield { type: 'text-delta', text: text.slice(i, i + 40) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const audit = tmpFile('audit-effort-fallback')
  const h = checklistHarness(llm, { auditFile: audit, reasoningEffort: 'low' })
  await h.stop()
  check('档位被拒后重试一次', llm.calls.length === 2, `calls=${llm.calls.length}`)
  check('档位被拒后第二次不传 effort', llm.calls[1]?.reasoningEffort === undefined, `effort=${llm.calls[1]?.reasoningEffort}`)
  const row = lastAuditRow(audit)
  check('档位被拒后仍正常判分', row.decision === 'pass' && row.score === 100, JSON.stringify(row))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 44. v6：上游 11133（模型不接受当前请求）也算档位不支持，要退回
{
  let attempt = 0
  const llm = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      attempt += 1
      if (attempt === 1) {
        return (async function* () {
          throw new Error('上游 11133：模型不接受当前请求')
        })()
      }
      const text = '1:10 2:10 3:10'
      return (async function* () {
        for (let i = 0; i < text.length; i += 40) yield { type: 'text-delta', text: text.slice(i, i + 40) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const h = harness({ dryRun: false, reasoningEffort: 'low' }, llm, baseEvents)
  await h.stop()
  check('上游 11133 也触发退回', llm.calls.length === 2, `calls=${llm.calls.length}`)
  check('上游 11133 退回后不传 effort', llm.calls[1]?.reasoningEffort === undefined, `effort=${llm.calls[1]?.reasoningEffort}`)
}

// 45. v1.4.0：真错误（不是档位问题）不许被当成「档位不支持」而丢掉 effort；槽 2 也不换档
{
  const llm = fakeLlm(new Error('upstream 502 bad gateway'))
  const audit = tmpFile('audit-effort-real-error')
  const h = harness({ dryRun: false, auditFile: audit, reasoningEffort: 'low' }, llm, baseEvents)
  await h.stop()
  // 两次调用＝一次主判 + 一次补判；关键是两次都还带着用户显式选的档位（不升档、不丢失）。
  check('真错误两槽都保留 effort（low,low）', llm.calls.map((call) => call.reasoningEffort).join(',') === 'low,low', llm.calls.map((call) => call.reasoningEffort).join(','))
  const row = lastAuditRow(audit)
  check('真错误走 unknown 出口', row.decision === 'unknown', JSON.stringify(row))
  check('真错误审计记 attempts=2', row.attempts === 2, JSON.stringify(row))
  fs.unlinkSync(audit)
}
// 46. v6：截断也要能判——判定在第一行，尾巴掉了不影响
{
  const audit = tmpFile('audit-cl-trunc')
  const chunks = [
    { type: 'text-delta', text: '1:2 2:10 3:10\nFIX: 开头直接给结' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  const h = checklistHarness(fakeLlmChunks(chunks), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('截断的分数行仍能判分', row.score === 43, JSON.stringify(row))
  check('截断的清单仍判 fail', row.decision === 'fail', JSON.stringify(row))
  check('截断的清单不记 error', row.error === undefined, JSON.stringify(row.error))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 47. v6：判据里没有编号条目 → 退回老的 SCORE 问法
{
  const criteriaFile = `${process.env.TEMP ?? '/tmp'}/selfcheck-criteria-${Date.now()}.md`
  fs.writeFileSync(criteriaFile, '判据：结论前置，别铺垫。\n', 'utf8')
  const audit = tmpFile('audit-no-checklist')
  const llm = fakeLlm('SCORE: 40\nVERDICT: fail\nWORST: 铺垫太长\nFIX: 结论前置')
  const h = harness({ dryRun: false, auditFile: audit, criteriaFile }, llm, baseEvents)
  await h.stop()
  const prompt = String(llm.calls[0]?.messages?.[0]?.content?.[0]?.text ?? '')
  check('无编号判据时退回 SCORE 问法', prompt.includes('SCORE: 0-100'), prompt.slice(-200))
  const row = lastAuditRow(audit)
  check('无编号判据时仍能判分', row.score === 40, JSON.stringify(row))
  check('无编号判据时 scoreSource=lines', row.scoreSource === 'lines', JSON.stringify(row))
  fs.unlinkSync(audit)
  fs.unlinkSync(criteriaFile)
}

// 48. v6.1：面板把 reasoningEffort 写在**顶层**，引擎必须认（曾经只读 judge.reasoningEffort，面板改了不生效）
{
  const settingsFile = `${process.env.TEMP ?? '/tmp'}/selfcheck-settings-${Date.now()}.json`
  const audit = tmpFile('audit-live-effort')
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        enabled: true,
        dryRun: false,
        triggers: { minReplyChars: 0, maxReworks: 3, scoreThreshold: 70 },
        judge: { timeoutMs: 60000, maxTokens: 4000, model: null },
        criteria: [
          { id: 'a', enabled: true, text: '结论放在最前面' },
          { id: 'b', enabled: true, text: '说人话' },
        ],
        reasoningEffort: 'minimal',
        auditFile: audit,
      },
      null,
      2,
    ),
    'utf8',
  )
  const llm = fakeLlm('1:10 2:10')
  const h = harness({ dryRun: false, settingsFile, auditFile: audit }, llm, baseEvents)
  await h.stop()
  check('活设置顶层 reasoningEffort 生效', llm.calls[0]?.reasoningEffort === 'minimal', `effort=${llm.calls[0]?.reasoningEffort}`)
  const row = lastAuditRow(audit)
  check('活设置顶层 effort 记进审计', row.effort === 'minimal', `effort=${row.effort}`)
  fs.unlinkSync(audit)
  fs.unlinkSync(settingsFile)
}

/**
 * ── v1.4.0（契约 v1.4.0）：判官不再猜档位、不再自设截止、预算固定 32768 ──────────
 *
 * 依据（生产审计 336 行）：
 *  - `attempts=2` 共 7 行、**成功 0 行**，全部是被 provider 拒掉的 `medium`
 *    （`does not support reasoning effort "medium"`）→ 升档那一半从来没救回过东西。
 *  - v1.3 起 reasonChars p90 2440 字符、最坏 3448 字符 ≈ 2369 token，占 4976 的 48%，
 *    一次都没逼近过上限 → 「够不够」没有调参的必要，直接封顶。
 *  - 本机唯一两次成功的调用（`raccoon` 60 分、`qodercn/gfmodel` 100 分）都是**不发档位**。
 */

// 49. v1.4.0：默认**不发送**任何档位
{
  const llm = fakeLlm('1:10 2:10 3:10')
  const h = harness({ dryRun: false }, llm, baseEvents)
  await h.stop()
  check('AUTO_START 是 default（＝不发档位）', AUTO_START === 'default', AUTO_START)
  check('默认不发送 reasoningEffort', llm.calls[0]?.reasoningEffort === undefined, `effort=${llm.calls[0]?.reasoningEffort}`)
}

// 50. v1.4.0：旧值 'auto' 与不写等价，都收敛到「不发」
{
  const llm = fakeLlm('1:10 2:10 3:10')
  const h = harness({ dryRun: false, reasoningEffort: 'auto' }, llm, baseEvents)
  await h.stop()
  check('显式 auto 也不发档位', llm.calls[0]?.reasoningEffort === undefined, `effort=${llm.calls[0]?.reasoningEffort}`)
}

// 51. v1.4.0：槽 2 不换档、不换预算，只是同参数 + 更短提示再问一次
{
  let attempt = 0
  const llm = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      attempt += 1
      const body = attempt === 1 ? '我先想想……' : '1:10 2:10 3:10'
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: body }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const audit = tmpFile('audit-slot-same')
  const h = checklistHarness(llm, { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('槽 1 不发档位', llm.calls[0]?.reasoningEffort === undefined, `effort=${llm.calls[0]?.reasoningEffort}`)
  check('槽 2 也不发档位（不升档）', llm.calls[1]?.reasoningEffort === undefined, `effort=${llm.calls[1]?.reasoningEffort}`)
  check('两槽预算相同', llm.calls[0]?.maxTokens === llm.calls[1]?.maxTokens, `${llm.calls[0]?.maxTokens} vs ${llm.calls[1]?.maxTokens}`)
  check('两槽预算都是 JUDGE_MAX_TOKENS', llm.calls[0]?.maxTokens === JUDGE_MAX_TOKENS, `budget=${llm.calls[0]?.maxTokens}`)
  check('审计记 attempts=2', row.attempts === 2, JSON.stringify(row))
  check('审计 effort 记 default', row.effort === 'default', JSON.stringify(row))
  check('审计 maxTokens 记 32768', row.maxTokens === JUDGE_MAX_TOKENS, JSON.stringify(row))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 52. v1.4.0：显式选了档位 → 两槽都用它，不再升一级
{
  const llm = fakeLlm(new Error('upstream 502 bad gateway'))
  const h = harness({ dryRun: false, onUnknown: 'pass', reasoningEffort: 'high' }, llm, baseEvents)
  await h.stop()
  check(
    '显式 high 两槽都是 high（不升档）',
    llm.calls.map((call) => call.reasoningEffort).join(',') === 'high,high',
    llm.calls.map((call) => call.reasoningEffort).join(','),
  )
}

// 53. v1.4.0：显式 maxTokens 仍是逃生舱
{
  const llm = fakeLlm('1:10 2:10 3:10')
  const audit = tmpFile('audit-fixed-tokens')
  const h = checklistHarness(llm, { auditFile: audit, maxTokens: 900 })
  await h.stop()
  const row = lastAuditRow(audit)
  check('显式 maxTokens 照用', llm.calls[0]?.maxTokens === 900, `budget=${llm.calls[0]?.maxTokens}`)
  check('显式 maxTokens 写进审计', row.maxTokens === 900, JSON.stringify(row))
  check('显式 maxTokens 不改档位', llm.calls[0]?.reasoningEffort === undefined, `effort=${llm.calls[0]?.reasoningEffort}`)
  h.cleanup()
  fs.unlinkSync(audit)
}

// 54. v1.4.0：JUDGE_MAX_TOKENS 就是 32768（中继 Math.min 之后能拿到的最大值）
{
  check('JUDGE_MAX_TOKENS = 32768', JUDGE_MAX_TOKENS === 32768, String(JUDGE_MAX_TOKENS))
  const llm = fakeLlm('1:10 2:10 3:10')
  const h = checklistHarness(llm, {})
  await h.stop()
  check('默认预算就是 32768', llm.calls[0]?.maxTokens === 32768, `budget=${llm.calls[0]?.maxTokens}`)
  h.cleanup()
}

// 55. v1.4.0：显式 off 仍走「上游不认就退回不传」的老路径，而且算同一个槽（attempts=1）
{
  let attempt = 0
  const llm = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      attempt += 1
      if (attempt === 1) {
        return (async function* () {
          throw new Error('上游 11133：模型不接受当前请求')
        })()
      }
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '1:10 2:10 3:10' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const audit = tmpFile('audit-explicit-off')
  const h = checklistHarness(llm, { auditFile: audit, reasoningEffort: 'off' })
  await h.stop()
  const row = lastAuditRow(audit)
  check('显式 off 第一次确实发了', llm.calls[0]?.reasoningEffort === 'off', `effort=${llm.calls[0]?.reasoningEffort}`)
  check('显式 off 被拒后第二次不传 effort', llm.calls[1]?.reasoningEffort === undefined, `effort=${llm.calls[1]?.reasoningEffort}`)
  check('显式 off 的退回仍算槽 1（attempts=1）', row.attempts === 1, JSON.stringify(row))
  check('显式 off 退回后照样判分', row.decision === 'pass', JSON.stringify(row))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 56. v1.4.0：显式 off 没被拒但拿不到裁定 → 槽 2 仍是 off（不换档）
{
  let attempt = 0
  const llm = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      attempt += 1
      const body = attempt === 1 ? '我不知道' : '1:10 2:10 3:10'
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: body }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const h = checklistHarness(llm, { reasoningEffort: 'off' })
  await h.stop()
  check('显式 off 的槽 2 还是 off', llm.calls[1]?.reasoningEffort === 'off', `effort=${llm.calls[1]?.reasoningEffort}`)
  h.cleanup()
}

// 57. v1.4.0：活设置写 auto + judge.maxTokens=null → 不发档位、预算 32768
{
  const settingsFile = `${process.env.TEMP ?? '/tmp'}/selfcheck-settings-auto-${Date.now()}.json`
  const audit = tmpFile('audit-live-auto')
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        enabled: true,
        dryRun: false,
        triggers: { minReplyChars: 0, maxReworks: 3, scoreThreshold: 70 },
        judge: { timeoutMs: 60000, maxTokens: null, model: null },
        criteria: [
          { id: 'a', enabled: true, text: '结论放在最前面' },
          { id: 'b', enabled: true, text: '说人话' },
        ],
        reasoningEffort: 'auto',
        auditFile: audit,
      },
      null,
      2,
    ),
    'utf8',
  )
  const llm = fakeLlm('1:10 2:10')
  const h = harness({ dryRun: false, settingsFile, auditFile: audit }, llm, baseEvents)
  await h.stop()
  const row = lastAuditRow(audit)
  check('活设置 auto → 不发档位', llm.calls[0]?.reasoningEffort === undefined, `effort=${llm.calls[0]?.reasoningEffort}`)
  check('活设置 maxTokens=null → 预算 32768', llm.calls[0]?.maxTokens === JUDGE_MAX_TOKENS, `budget=${llm.calls[0]?.maxTokens}`)
  check('预算 32768 写进审计', row.maxTokens === JUDGE_MAX_TOKENS, JSON.stringify(row))
  fs.unlinkSync(audit)
  fs.unlinkSync(settingsFile)
}

// 58. v7（修订 C）：活设置 null 不算「有数字」，仍然回落到 patch 的固定值
//     （老挂载点里就写着 maxTokens: 4000；lead 部署时删掉它，删掉之后才走自动）
{
  const settingsFile = `${process.env.TEMP ?? '/tmp'}/selfcheck-settings-override-${Date.now()}.json`
  const audit = tmpFile('audit-live-override')
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        enabled: true,
        dryRun: false,
        triggers: { minReplyChars: 0, maxReworks: 3, scoreThreshold: 70 },
        judge: { timeoutMs: 60000, maxTokens: null, model: null },
        criteria: [
          { id: 'a', enabled: true, text: '结论放在最前面' },
          { id: 'b', enabled: true, text: '说人话' },
        ],
        auditFile: audit,
      },
      null,
      2,
    ),
    'utf8',
  )
  const llm = fakeLlm('1:10 2:10')
  const h = harness({ dryRun: false, settingsFile, auditFile: audit, maxTokens: 4000 }, llm, baseEvents)
  await h.stop()
  const row = lastAuditRow(audit)
  check('活设置 null → 回落 patch 的 4000', llm.calls[0]?.maxTokens === 4000, `budget=${llm.calls[0]?.maxTokens}`)
  check('回落固定值时 maxTokensAuto=false', row.maxTokensAuto === false, JSON.stringify(row))
  fs.unlinkSync(audit)
  fs.unlinkSync(settingsFile)
}

// 59. v7：活设置**没写** judge.maxTokens 时，回落到 patch 的固定值（老分层不变）
{
  const settingsFile = `${process.env.TEMP ?? '/tmp'}/selfcheck-settings-fallback-${Date.now()}.json`
  const audit = tmpFile('audit-live-fallback')
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        enabled: true,
        dryRun: false,
        triggers: { minReplyChars: 0, maxReworks: 3, scoreThreshold: 70 },
        judge: { timeoutMs: 60000, model: null },
        criteria: [
          { id: 'a', enabled: true, text: '结论放在最前面' },
          { id: 'b', enabled: true, text: '说人话' },
        ],
        auditFile: audit,
      },
      null,
      2,
    ),
    'utf8',
  )
  const llm = fakeLlm('1:10 2:10')
  const h = harness({ dryRun: false, settingsFile, auditFile: audit, maxTokens: 4000 }, llm, baseEvents)
  await h.stop()
  const row = lastAuditRow(audit)
  check('活设置缺键 → 回落 patch 固定值', llm.calls[0]?.maxTokens === 4000, `budget=${llm.calls[0]?.maxTokens}`)
  check('回落时 maxTokensAuto=false', row.maxTokensAuto === false, JSON.stringify(row))
  fs.unlinkSync(audit)
  fs.unlinkSync(settingsFile)
}

// 60. v1.4.0：活设置与 mount config 都没有 maxTokens → 固定 32768，审计记 maxTokensAuto=false
{
  const settingsFile = `${process.env.TEMP ?? '/tmp'}/selfcheck-settings-nobudget-${Date.now()}.json`
  const audit = tmpFile('audit-live-nobudget')
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        enabled: true,
        dryRun: false,
        triggers: { minReplyChars: 0, maxReworks: 3, scoreThreshold: 70 },
        judge: { timeoutMs: 60000, model: null },
        criteria: [
          { id: 'a', enabled: true, text: '结论放在最前面' },
          { id: 'b', enabled: true, text: '说人话' },
        ],
        auditFile: audit,
      },
      null,
      2,
    ),
    'utf8',
  )
  const llm = fakeLlm('1:10 2:10')
  const h = harness({ dryRun: false, settingsFile, auditFile: audit }, llm, baseEvents)
  await h.stop()
  const row = lastAuditRow(audit)
  check('两边都没有 → 预算 32768', llm.calls[0]?.maxTokens === JUDGE_MAX_TOKENS, `budget=${llm.calls[0]?.maxTokens}`)
  check('固定预算审计 maxTokensAuto=false', row.maxTokensAuto === false, JSON.stringify(row))
  fs.unlinkSync(audit)
  fs.unlinkSync(settingsFile)
}

// 61. v7（修订 D）：两条打回文案都要求「不要复述这条提示」
{
  const hFail = harness({ dryRun: false }, fakeLlm('{"score": 30, "verdict": "fail"}'), baseEvents)
  await hFail.stop()
  const failText = String(hFail.steered[0]?.content?.[0]?.text ?? '')
  check('fail 打回文案要求不复述提示', failText.includes('不用在回复里复述'), failText.slice(-30))

  const hUnknown = harness({ dryRun: false }, fakeLlm('我不知道'), baseEvents)
  await hUnknown.stop()
  const unknownText = String(hUnknown.steered[0]?.content?.[0]?.text ?? '')
  check('unknown 打回文案要求不复述提示', unknownText.includes('不用在回复里复述'), unknownText.slice(-30))
}

// 62. v1.3.1：档位被拒**也可能走 finish.failure 而不是 throw**
//     实测：raccoon/sn-deepseek-v4-1-flash-1017 对 low 回 `does not support reasoning effort "low"`，
//     judgeMs=0、textChars=0，抛都没抛。老版只接 throw，于是两槽都用被拒的档位各撞一次，
//     最后 decision=unknown → onUnknown=rework，用户被白白打回三轮。
{
  let attempt = 0
  const llm = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      attempt += 1
      if (attempt === 1) {
        // 不抛错：把失败塞进 finish.reason.failure
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider "raccoon" model "x" does not support reasoning effort "low"' } } }
        })()
      }
      const text = '1:10 2:10 3:10'
      return (async function* () {
        for (let i = 0; i < text.length; i += 40) yield { type: 'text-delta', text: text.slice(i, i + 40) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const audit = tmpFile('audit-finish-refusal')
  // v1.4.0 默认不发档位，要复现「档位被拒」必须显式选一个档
  const h = checklistHarness(llm, { auditFile: audit, reasoningEffort: 'low' })
  await h.stop()
  check('finish 里的档位拒绝也触发退回', llm.calls.length === 2, `calls=${llm.calls.length}`)
  check('finish 拒绝退回后不传 effort', llm.calls[1]?.reasoningEffort === undefined, `effort=${llm.calls[1]?.reasoningEffort}`)
  const row = lastAuditRow(audit)
  check('finish 拒绝退回后仍正常判分（不再 unknown）', row.decision === 'pass' && row.score === 100, JSON.stringify(row))
  check('finish 拒绝退回后 attempts=1', row.attempts === 1, `attempts=${row.attempts}`)
  h.cleanup()
  fs.unlinkSync(audit)
}

// 63. v1.3.1：finish 里是**真错误**（不是档位问题）时，不许把它当成档位拒绝而重复调用
{
  const llm = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream 502 bad gateway' } } }
      })()
    },
  }
  const audit = tmpFile('audit-finish-real-error')
  const h = checklistHarness(llm, { auditFile: audit })
  await h.stop()
  // 主判 + 补判＝2 次，不能因为误判成档位拒绝再多出第 3 次
  check('finish 真错误不做档位退回（只有两槽）', llm.calls.length === 2, `calls=${llm.calls.length}`)
  const row = lastAuditRow(audit)
  check('finish 真错误仍走 unknown', row.decision === 'unknown', JSON.stringify(row))
  check('finish 真错误审计 attempts=2', row.attempts === 2, `attempts=${row.attempts}`)
  h.cleanup()
  fs.unlinkSync(audit)
}

// 64. v1.3.1：路由级记忆——这个 provider/model 拒过档位，下一轮就别再白撞
{
  let refused = false
  const llm = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      if (!refused) {
        refused = true
        return (async function* () {
          throw new Error('provider "raccoon" model "x" does not support reasoning effort "low"')
        })()
      }
      const text = '1:10 2:10 3:10'
      return (async function* () {
        for (let i = 0; i < text.length; i += 40) yield { type: 'text-delta', text: text.slice(i, i + 40) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const audit = tmpFile('audit-route-memory')
  // v1.4.0 默认不发档位，要复现「拒过档位的路由」必须显式选一个档
  const h = checklistHarness(llm, { auditFile: audit, reasoningEffort: 'low' })
  await h.stop(1)
  const afterTurn1 = llm.calls.length
  await h.stop(2)
  const turn2 = llm.calls.slice(afterTurn1)
  check('拒过档位的路由下一轮不再带 effort', turn2.every((call) => call.reasoningEffort === undefined), JSON.stringify(turn2.map((c) => c.reasoningEffort)))
  check('下一轮只调一次上游（不再白撞+重试）', turn2.length === 1, `calls=${turn2.length}`)
  h.cleanup()
  fs.unlinkSync(audit)
}

// ── v1.4.0：逐条 0-10 打分 ──────────────────────────────────────────────
// 背景：judge 走过「逐条 yes/no」。判据表里有条目在技术问答里**没有判定对象**
// （「保持某某人设」「结论要量化打分」），这些条一律判 no，分母又恒等于条数，
// 把本该 100 分的回复压到 60/40/24。实测 audit.jsonl 358 行 / 63 行带 checks：
// ④ no 20 次、⑤ no 18 次，只有 4/5 挂的 17 行本该 100，其中 8 行真被打回（占 24 次打回的 33%）。
// 先加过第三态 na，但用户否了（「用户随时会去调整质检词，你不知道哪几条要打分」），
// 于是改成**每条都给一个 0-10 的分**，「客观加不了」写进提示词算 10 分。

// 65. 一条 4 分其余满分 → 一票否决（v1.5.0 起；v1.4.0 时这里是 80 分 pass）
{
  const audit = tmpFile('audit-sc-partial-pass')
  const h = checklistHarness(fakeLlm('1:10 2:10 3:4\nFIX: 别旁生枝节'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('一条 4 分其余满分 → 按 59 折算（47 分）', row.score === 47, `score=${row.score}`)
  check('一条 4 分 → 直接打回（任一条可一票否决）', row.decision === 'fail', JSON.stringify(row))
  check('失分条目写进 worst', String(row.worst ?? '').includes('第 3 条'), String(row.worst))
  check('worst 带上实际得分', String(row.worst ?? '').includes('4/10'), String(row.worst))
  check('低分要回炉', h.steered.length === 1, `steered=${h.steered.length}`)
  h.cleanup()
  fs.unlinkSync(audit)
}

// 66. 越界分（判官写 100）当未答，绝不当成满分
{
  const audit = tmpFile('audit-sc-range')
  const h = checklistHarness(fakeLlm('1:10 2:100 3:10'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('越界分按未答处理（67 分）', row.score === 67, `score=${row.score}`)
  check('越界分判 fail', row.decision === 'fail', JSON.stringify(row))
  check('越界分记进 incomplete', Array.isArray(row.incomplete) && row.incomplete.includes(2), JSON.stringify(row.incomplete))
  check('越界分不写进 checks', row.checks?.[1]?.score === undefined, JSON.stringify(row.checks))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 67. 判官一种分数都没给 → 走三层抢救，抢救不到按 unknown（不瞎猜分数）
{
  const audit = tmpFile('audit-sc-none')
  const h = checklistHarness(fakeLlm('我觉得还行吧'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('一个分数都没有 → unknown', row.decision === 'unknown', JSON.stringify(row))
  check('一个分数都没有 → 审计不记 score', row.score === undefined, JSON.stringify(row))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 68. 分数写法容错：`8/10`、全角冒号、逗号分隔、`2. 9`
{
  const audit = tmpFile('audit-sc-format')
  const h = checklistHarness(fakeLlm('1：8，2. 9，3:10'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('全角冒号/逗号/点号都认', row.score === 90, `score=${row.score}`)
  h.cleanup()
  fs.unlinkSync(audit)

  const audit2 = tmpFile('audit-sc-slash')
  const h2 = checklistHarness(fakeLlm('1:10 2:8/10 3:10'), { auditFile: audit2 })
  await h2.stop()
  const row2 = lastAuditRow(audit2)
  check('`8/10` 这种写法也认（93 分）', row2.score === 93, `score=${row2.score}`)
  h2.cleanup()
  fs.unlinkSync(audit2)
}

// 69. 第 1 条 4 分（<6）→ 满分按 59 折算：sum=24 → round(0.8*59)=47
{
  const audit = tmpFile('audit-sc-gate-4')
  const h = checklistHarness(fakeLlm('1:4 2:10 3:10\nFIX: 开头直接给结论'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('第 1 条 4 分 → 47 分', row.score === 47, `score=${row.score}`)
  check('第 1 条 4 分 → fail', row.decision === 'fail', JSON.stringify(row))
  check('第 1 条 4 分 → 回炉', h.steered.length === 1, `steered=${h.steered.length}`)
  h.cleanup()
  fs.unlinkSync(audit)
}

// 70. 每条都 6 分（无一条低于 6）→ 不触发硬门槛，就是 60 分 fail
{
  const audit = tmpFile('audit-sc-flat')
  const h = checklistHarness(fakeLlm('1:6 2:6 3:6\nFIX: 全都要改'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('全 6 分 → 60 分', row.score === 60, `score=${row.score}`)
  check('全 6 分 → fail（低于及格线 70）', row.decision === 'fail', JSON.stringify(row))
  check('没有低于 6 的条目时 worst 为空（硬门槛没触发）', row.worst === '', String(row.worst))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 71. 分数写在一行里，截断只吃掉尾巴——截断仍能判分
{
  const audit = tmpFile('audit-sc-trunc')
  const chunks = [
    { type: 'text-delta', text: '1:2 2:10 3:10\nFIX: 开头直接给结' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  const h = checklistHarness(fakeLlmChunks(chunks), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('截断的分数行仍能判分（43）', row.score === 43, JSON.stringify(row))
  check('截断仍记 scoreSource=scores', row.scoreSource === 'scores', JSON.stringify(row))
  check('截断不记 error', row.error === undefined, JSON.stringify(row.error))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 72. 审计里 checks 是分数数组，且跟 worst 对得上（事后能复盘「这条为什么扣分」）
{
  const audit = tmpFile('audit-sc-checks')
  const h = checklistHarness(fakeLlm('1:10 2:3 3:10'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('checks 三条齐全', Array.isArray(row.checks) && row.checks.length === 3, JSON.stringify(row.checks))
  check('checks 记的是 0-10 分数', JSON.stringify(row.checks.map((entry) => entry.score)) === '[10,3,10]', JSON.stringify(row.checks))
  check('checks 带判据 id（就是判据里的编号）', JSON.stringify(row.checks.map((entry) => entry.id)) === '[1,2,3]', JSON.stringify(row.checks))
  check('checks 与 worst 一致（第 2 条 3/10）', String(row.worst ?? '').includes('第 2 条只拿到 3/10'), String(row.worst))
  check('审计不再有 na 字段', row.naCount === undefined && row.applicable === undefined && row.naSuspicious === undefined, JSON.stringify(row))
  h.cleanup()
  fs.unlinkSync(audit)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
