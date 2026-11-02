/**
 * selfcheck-guard 的离线自测：不需要真 DSH，也不需要真模型。
 *
 * 跑法（PATH 上没有 node，用 runtime 自带的那个）：
 *   node selftest.mjs
 */

import fs from 'node:fs'
import { apply, name, autoBudget, AUTO_START } from './index.mjs'

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
  check('补判的提示是更短的清单版', String(llm.calls[1]?.messages?.[0]?.content?.[0]?.text ?? '').includes('只输出这一行判定结果'))
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
 * v6：清单模式。
 *
 * 背景（实测，见 `.scratch/probe-judge-*.mjs`）：让判官给「0-100 一个整数」，
 * 同一段回复连判 9 次得 40/1/2/20/20/20/30/25/55（range 54），还会自作主张换成 `SCORE: 2/10`。
 * 改成逐条 yes/no 后同一批用例 range 0~11。这一组守的就是「别再退回打分模式」。
 */
const CHECKLIST_CRITERIA = [
  '判据（任一条不满足即不合格）：',
  '1. 最核心的那一条放在最前面直接给出。',
  '2. 用最简单最直白的话说。',
  '3. 不旁生枝节。',
].join('\n')

/** 写一份只有 3 条编号判据的临时文件（清单模式要靠编号才启用）。 */
const checklistCriteriaFile = () => {
  const file = `${process.env.TEMP ?? '/tmp'}/selfcheck-criteria-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
  fs.writeFileSync(file, CHECKLIST_CRITERIA, 'utf8')
  return file
}

const checklistHarness = (llm, config = {}) => {
  const criteriaFile = checklistCriteriaFile()
  const h = harness({ dryRun: false, criteriaFile, ...config }, llm, baseEvents)
  h.cleanup = () => fs.rmSync(criteriaFile, { force: true })
  return h
}

// 33. 清单模式：全 yes → 100 分 pass，且走的是 checklist 分支
{
  const audit = tmpFile('audit-cl-all')
  const h = checklistHarness(fakeLlm('1:yes 2:yes 3:yes\nFIX: 无需改动'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('清单全 yes 记 100 分', row.score === 100, JSON.stringify(row))
  check('清单全 yes 判 pass', row.decision === 'pass', JSON.stringify(row))
  check('清单模式 scoreSource=checklist', row.scoreSource === 'checklist', JSON.stringify(row))
  check('清单模式不回炉', h.steered.length === 0, `steered=${h.steered.length}`)
  h.cleanup()
  fs.unlinkSync(audit)
}

// 34. 清单模式：第 1 条 no 是硬门槛，满分只按 59 折算
{
  const audit = tmpFile('audit-cl-gate')
  const h = checklistHarness(fakeLlm('1:no 2:yes 3:yes\nFIX: 开头直接给结论'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('第 1 条不过则分数按 59 折算', row.score === 39, `score=${row.score}`)
  check('第 1 条不过就判 fail', row.decision === 'fail', JSON.stringify(row))
  check('第 1 条不过真回炉', h.steered.length === 1, `steered=${h.steered.length}`)
  check('回炉文案点名是哪一条', String(h.steered[0]?.content?.[0]?.text ?? '').includes('最核心的那一条'), String(h.steered[0]?.content?.[0]?.text ?? ''))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 35. 清单模式：第 2、3 条 no → 33 分 fail
{
  const audit = tmpFile('audit-cl-partial')
  const h = checklistHarness(fakeLlm('1:yes 2:no 3:no\nFIX: 说人话'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('清单部分不过按比例折算', row.score === 33, `score=${row.score}`)
  check('清单部分不过判 fail', row.decision === 'fail', JSON.stringify(row))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 36. 清单模式：答漏编号时，已答出来的部分照样算分（只要第 1 条在）
{
  const audit = tmpFile('audit-cl-missing')
  const h = checklistHarness(fakeLlm('1:yes 2:yes'), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('答漏编号仍按已答部分算分', row.score === 67, `score=${row.score}`)
  check('答漏编号会记下漏了哪几条', Array.isArray(row.incomplete) && row.incomplete.includes(3), JSON.stringify(row.incomplete))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 37. 清单模式：判官改口吐老格式 JSON，也认（要的是裁定，不是格式）
{
  const audit = tmpFile('audit-cl-json')
  const h = harness({ dryRun: false, auditFile: audit }, fakeLlm({ score: 88, verdict: 'pass' }), baseEvents)
  await h.stop()
  const row = lastAuditRow(audit)
  check('清单模式里老 JSON 也认', row.score === 88, JSON.stringify(row))
  check('清单模式里老 JSON 记 scoreSource=json', row.scoreSource === 'json', JSON.stringify(row))
  fs.unlinkSync(audit)
}

// 38. 清单模式：判官只吐老格式 `SCORE: 30` 也认
{
  const audit = tmpFile('audit-cl-score')
  const h = harness({ dryRun: false, auditFile: audit }, fakeLlm('SCORE: 30'), baseEvents)
  await h.stop()
  const row = lastAuditRow(audit)
  check('清单模式里 SCORE 行也认', row.score === 30, JSON.stringify(row))
  check('清单模式里 SCORE 行判 fail', row.decision === 'fail', JSON.stringify(row))
  fs.unlinkSync(audit)
}

// 39. 清单模式：提示里必须把编号列出来，且要求一条不漏
{
  const llm = fakeLlm('1:yes 2:yes 3:yes')
  const h = harness({ dryRun: false }, llm, baseEvents)
  await h.stop()
  const prompt = String(llm.calls[0]?.messages?.[0]?.content?.[0]?.text ?? '')
  check('清单提示带全部编号', prompt.includes('1:yes') && prompt.includes('3:yes'), prompt.slice(0, 200))
  check('清单提示要求一条不漏', prompt.includes('一条都不许漏'))
  check('清单提示把判定放第一行', prompt.includes('第一行必须是全部判定结果'))
}

// 40. v6：判官必须显式传 reasoningEffort（不传就继承 profile 的 high，token 全被推理吃掉）
{
  const llm = fakeLlm('1:yes 2:yes 3:yes')
  const h = harness({ dryRun: false }, llm, baseEvents)
  await h.stop()
  check('判官显式传 reasoningEffort', llm.calls[0]?.reasoningEffort === 'low', `effort=${llm.calls[0]?.reasoningEffort}`)
}

// 41. v6：reasoningEffort 可配，配成 high 就传 high
{
  const llm = fakeLlm('1:yes 2:yes 3:yes')
  const h = harness({ dryRun: false, reasoningEffort: 'high' }, llm, baseEvents)
  await h.stop()
  check('reasoningEffort 可配成 high', llm.calls[0]?.reasoningEffort === 'high', `effort=${llm.calls[0]?.reasoningEffort}`)
}

// 42. v6：非法 reasoningEffort 当场报错
{
  let threw
  try {
    harness({ reasoningEffort: 'turbo' }, fakeLlm('1:yes'), baseEvents)
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
      const text = '1:yes 2:yes 3:yes'
      return (async function* () {
        for (let i = 0; i < text.length; i += 40) yield { type: 'text-delta', text: text.slice(i, i + 40) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const audit = tmpFile('audit-effort-fallback')
  const h = checklistHarness(llm, { auditFile: audit })
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
      const text = '1:yes 2:yes 3:yes'
      return (async function* () {
        for (let i = 0; i < text.length; i += 40) yield { type: 'text-delta', text: text.slice(i, i + 40) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const h = harness({ dryRun: false }, llm, baseEvents)
  await h.stop()
  check('上游 11133 也触发退回', llm.calls.length === 2, `calls=${llm.calls.length}`)
  check('上游 11133 退回后不传 effort', llm.calls[1]?.reasoningEffort === undefined, `effort=${llm.calls[1]?.reasoningEffort}`)
}

// 45. v6/v7：真错误（不是档位问题）不许被当成「档位不支持」而丢掉 effort；槽 2 还要升一级
{
  const llm = fakeLlm(new Error('upstream 502 bad gateway'))
  const audit = tmpFile('audit-effort-real-error')
  const h = harness({ dryRun: false, auditFile: audit }, llm, baseEvents)
  await h.stop()
  // 两次调用＝一次主判 + 一次补判；关键是两次都还带着 effort（low→medium 是升档，不是丢失）。
  check('真错误两槽都保留 effort（low,medium）', llm.calls.map((call) => call.reasoningEffort).join(',') === 'low,medium', llm.calls.map((call) => call.reasoningEffort).join(','))
  const row = lastAuditRow(audit)
  check('真错误走 unknown 出口', row.decision === 'unknown', JSON.stringify(row))
  check('真错误审计记 attempts=2', row.attempts === 2, JSON.stringify(row))
  fs.unlinkSync(audit)
}
// 46. v6：截断也要能判——判定在第一行，尾巴掉了不影响
{
  const audit = tmpFile('audit-cl-trunc')
  const chunks = [
    { type: 'text-delta', text: '1:no 2:yes 3:yes\nFIX: 开头直接给结' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  const h = checklistHarness(fakeLlmChunks(chunks), { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('截断的清单仍能判分', row.score === 39, JSON.stringify(row))
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
  const llm = fakeLlm('1:yes 2:yes')
  const h = harness({ dryRun: false, settingsFile, auditFile: audit }, llm, baseEvents)
  await h.stop()
  check('活设置顶层 reasoningEffort 生效', llm.calls[0]?.reasoningEffort === 'minimal', `effort=${llm.calls[0]?.reasoningEffort}`)
  const row = lastAuditRow(audit)
  check('活设置顶层 effort 记进审计', row.effort === 'minimal', `effort=${row.effort}`)
  fs.unlinkSync(audit)
  fs.unlinkSync(settingsFile)
}

/**
 * ── v7（契约 v1.3.0）：判官档位与输出预算全部自动化 ────────────────────────────
 *
 * 背景（生产审计实测）：11 条 `judge returned no JSON` 的 reasonChars 最高 4614、答案均 210 字符
 * ＝ 4000 的预算被推理吃光；judgeMs 最大 12442ms，远没到 timeoutMs 60000
 * ＝ 该升档的时候只是拿同一个档位原地重问一遍。
 */

// 49. v7：档位默认 auto，起手档就是导出常量 AUTO_START
{
  const llm = fakeLlm('1:yes 2:yes 3:yes')
  const h = harness({ dryRun: false }, llm, baseEvents)
  await h.stop()
  check('AUTO_START 是 low（契约 v1.3.0）', AUTO_START === 'low', AUTO_START)
  check('默认 auto 从 AUTO_START 起手', llm.calls[0]?.reasoningEffort === AUTO_START, `effort=${llm.calls[0]?.reasoningEffort}`)
}

// 50. v7：显式写 'auto' 与不写等价
{
  const llm = fakeLlm('1:yes 2:yes 3:yes')
  const h = harness({ dryRun: false, reasoningEffort: 'auto' }, llm, baseEvents)
  await h.stop()
  check('显式 auto 起手 low', llm.calls[0]?.reasoningEffort === 'low', `effort=${llm.calls[0]?.reasoningEffort}`)
}

// 51. v7：槽 2 升一级，且预算按新档位重算（自动预算下 medium 比 low 多 2048）
{
  let attempt = 0
  const llm = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      attempt += 1
      const body = attempt === 1 ? '我先想想……' : '1:yes 2:yes 3:yes'
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: body }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const audit = tmpFile('audit-slot-upgrade')
  const h = checklistHarness(llm, { auditFile: audit })
  await h.stop()
  const row = lastAuditRow(audit)
  check('槽 1 起手 low', llm.calls[0]?.reasoningEffort === 'low', `effort=${llm.calls[0]?.reasoningEffort}`)
  check('槽 2 升到 medium', llm.calls[1]?.reasoningEffort === 'medium', `effort=${llm.calls[1]?.reasoningEffort}`)
  check('槽 1 预算按 low 算', llm.calls[0]?.maxTokens === autoBudget('low', 3), `budget=${llm.calls[0]?.maxTokens}`)
  check('槽 2 预算按 medium 重算', llm.calls[1]?.maxTokens === autoBudget('medium', 3), `budget=${llm.calls[1]?.maxTokens}`)
  check('槽 2 预算真的比槽 1 大', llm.calls[1]?.maxTokens > llm.calls[0]?.maxTokens, `${llm.calls[0]?.maxTokens} -> ${llm.calls[1]?.maxTokens}`)
  check('审计记 attempts=2', row.attempts === 2, JSON.stringify(row))
  check('审计记实到的档位 medium', row.effort === 'medium', JSON.stringify(row))
  check('审计记实际用的 maxTokens', row.maxTokens === autoBudget('medium', 3), JSON.stringify(row))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 52. v7：到顶不再升（显式 high 时槽 2 还是 high）
{
  const llm = fakeLlm(new Error('upstream 502 bad gateway'))
  const h = harness({ dryRun: false, onUnknown: 'pass', reasoningEffort: 'high' }, llm, baseEvents)
  await h.stop()
  check('high 到顶不越界', llm.calls.map((call) => call.reasoningEffort).join(',') === 'high,high', llm.calls.map((call) => call.reasoningEffort).join(','))
}

// 53. v7：显式 maxTokens 仍是逃生舱 —— 两槽都用这个数字，不做自动预算
{
  const llm = fakeLlm('1:yes 2:yes 3:yes')
  const audit = tmpFile('audit-fixed-tokens')
  const h = checklistHarness(llm, { auditFile: audit, maxTokens: 900 })
  await h.stop()
  const row = lastAuditRow(audit)
  check('显式 maxTokens 照用', llm.calls[0]?.maxTokens === 900, `budget=${llm.calls[0]?.maxTokens}`)
  check('显式 maxTokens 写进审计', row.maxTokens === 900, JSON.stringify(row))
  check('显式 maxTokens 不改起手档', llm.calls[0]?.reasoningEffort === 'low', `effort=${llm.calls[0]?.reasoningEffort}`)
  h.cleanup()
  fs.unlinkSync(audit)
}

// 54. v7（修订 A）：autoBudget = clamp(round(p99×1.5) + 答案预留, 4096, 8000)
{
  // 契约钉死的五个点（items=5 时）：off/minimal 被 4096 兜住，low 4976、medium 6512、high 被 8000 兜住
  check('autoBudget off/5 = 4096（下限兜底）', autoBudget('off', 5) === 4096, String(autoBudget('off', 5)))
  check('autoBudget minimal/5 = 4096（下限兜底）', autoBudget('minimal', 5) === 4096, String(autoBudget('minimal', 5)))
  check('autoBudget low/5 = 4976', autoBudget('low', 5) === 4976, String(autoBudget('low', 5)))
  check('autoBudget medium/5 = 6512', autoBudget('medium', 5) === 6512, String(autoBudget('medium', 5)))
  check('autoBudget high/5 = 8000（上限封顶）', autoBudget('high', 5) === 8000, String(autoBudget('high', 5)))
  // 答案预留 = clamp(128+48*items, 256, 1024)；low 档 p99×1.5 = 4608
  check('autoBudget low/1 = 4864（答案预留下限 256）', autoBudget('low', 1) === 4864, String(autoBudget('low', 1)))
  check('autoBudget low/30 = 5632（答案预留封顶 1024）', autoBudget('low', 30) === 5632, String(autoBudget('low', 30)))
  check('autoBudget 认不出档位时按 AUTO_START', autoBudget('turbo', 5) === autoBudget(AUTO_START, 5), `${autoBudget('turbo', 5)}/${autoBudget(AUTO_START, 5)}`)
  check('autoBudget 永不低于下限 4096', autoBudget('off', 0) === 4096, String(autoBudget('off', 0)))
  check('autoBudget 永不超过上限 8000', autoBudget('high', 1000) === 8000, String(autoBudget('high', 1000)))
}

// 55. v7：显式 off 仍走「上游不认就退回不传」的老路径，而且算同一个槽（attempts=1）
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
        yield { type: 'text-delta', index: 0, text: '1:yes 2:yes 3:yes' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const audit = tmpFile('audit-explicit-off')
  const h = checklistHarness(llm, { auditFile: audit, reasoningEffort: 'off' })
  await h.stop()
  const row = lastAuditRow(audit)
  check('显式 off 被拒后第二次不传 effort', llm.calls[1]?.reasoningEffort === undefined, `effort=${llm.calls[1]?.reasoningEffort}`)
  check('显式 off 的退回仍算槽 1（attempts=1）', row.attempts === 1, JSON.stringify(row))
  check('显式 off 退回后照样判分', row.decision === 'pass', JSON.stringify(row))
  h.cleanup()
  fs.unlinkSync(audit)
}

// 56. v7：显式 off 没被拒但拿不到裁定 → 槽 2 才升到 minimal（尊重用户从 off 起手）
{
  let attempt = 0
  const llm = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      attempt += 1
      const body = attempt === 1 ? '我不知道' : '1:yes 2:yes 3:yes'
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: body }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const h = checklistHarness(llm, { reasoningEffort: 'off' })
  await h.stop()
  check('显式 off 的槽 2 升到 minimal', llm.calls[1]?.reasoningEffort === 'minimal', `effort=${llm.calls[1]?.reasoningEffort}`)
  h.cleanup()
}

// 57. v7：活设置写 auto + judge.maxTokens=null → 走自动预算
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
  const llm = fakeLlm('1:yes 2:yes')
  const h = harness({ dryRun: false, settingsFile, auditFile: audit }, llm, baseEvents)
  await h.stop()
  const row = lastAuditRow(audit)
  check('活设置 auto 起手 low', llm.calls[0]?.reasoningEffort === 'low', `effort=${llm.calls[0]?.reasoningEffort}`)
  check('活设置 maxTokens=null → 自动预算', llm.calls[0]?.maxTokens === autoBudget('low', 2), `budget=${llm.calls[0]?.maxTokens}`)
  check('自动预算写进审计', row.maxTokens === autoBudget('low', 2), JSON.stringify(row))
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
  const llm = fakeLlm('1:yes 2:yes')
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
  const llm = fakeLlm('1:yes 2:yes')
  const h = harness({ dryRun: false, settingsFile, auditFile: audit, maxTokens: 4000 }, llm, baseEvents)
  await h.stop()
  const row = lastAuditRow(audit)
  check('活设置缺键 → 回落 patch 固定值', llm.calls[0]?.maxTokens === 4000, `budget=${llm.calls[0]?.maxTokens}`)
  check('回落时 maxTokensAuto=false', row.maxTokensAuto === false, JSON.stringify(row))
  fs.unlinkSync(audit)
  fs.unlinkSync(settingsFile)
}

// 60. v7（修订 C）：活设置与 mount config 都没有 maxTokens → 自动预算，审计记 maxTokensAuto=true
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
  const llm = fakeLlm('1:yes 2:yes')
  const h = harness({ dryRun: false, settingsFile, auditFile: audit }, llm, baseEvents)
  await h.stop()
  const row = lastAuditRow(audit)
  check('两边都没有 → 自动预算', llm.calls[0]?.maxTokens === autoBudget('low', 2), `budget=${llm.calls[0]?.maxTokens}`)
  check('自动预算审计 maxTokensAuto=true', row.maxTokensAuto === true, JSON.stringify(row))
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
      const text = '1:yes 2:yes 3:yes'
      return (async function* () {
        for (let i = 0; i < text.length; i += 40) yield { type: 'text-delta', text: text.slice(i, i + 40) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const audit = tmpFile('audit-finish-refusal')
  const h = checklistHarness(llm, { auditFile: audit })
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
      const text = '1:yes 2:yes 3:yes'
      return (async function* () {
        for (let i = 0; i < text.length; i += 40) yield { type: 'text-delta', text: text.slice(i, i + 40) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const audit = tmpFile('audit-route-memory')
  const h = checklistHarness(llm, { auditFile: audit })
  await h.stop(1)
  const afterTurn1 = llm.calls.length
  await h.stop(2)
  const turn2 = llm.calls.slice(afterTurn1)
  check('拒过档位的路由下一轮不再带 effort', turn2.every((call) => call.reasoningEffort === undefined), JSON.stringify(turn2.map((c) => c.reasoningEffort)))
  check('下一轮只调一次上游（不再白撞+重试）', turn2.length === 1, `calls=${turn2.length}`)
  h.cleanup()
  fs.unlinkSync(audit)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
