/**
 * selfcheck-guard 的离线自测：不需要真 DSH，也不需要真模型。
 *
 * 跑法（PATH 上没有 node，用 runtime 自带的那个）：
 *   node selftest.mjs
 */

import { apply, name } from './index.mjs'

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
  return { stop, steered, warned }
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

// 7. 判官调用抛错 → 放行，不弄坏会话
{
  const h = harness({ dryRun: false }, fakeLlm(new Error('upstream 502')), baseEvents)
  await h.stop()
  check('判官抛错则放行', h.steered.length === 0)
  check('判官抛错留了日志', h.warned.some((line) => line.includes('letting the turn close')), h.warned.join(' | '))
}

// 8. 判官返回非 JSON → 放行
{
  const h = harness({ dryRun: false }, fakeLlm('我觉得还行吧'), baseEvents)
  await h.stop()
  check('非法输出则放行', h.steered.length === 0)
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
  const fs = await import('node:fs')
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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
