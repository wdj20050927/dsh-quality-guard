/**
 * settings.js — 质检设置的**唯一真源**（默认值、校验、归一、拼判据）。
 *
 * 落盘位置：%USERPROFILE%/.dsh/quality-guard/settings.json
 * 谁读它：① 本面板的宿主半侧（读写）② selfcheck-guard/index.mjs（每一轮现读，mtime 变了才重读）
 *
 * 所以「面板上改完即时生效」不是靠热重载，是靠引擎每次判决前重新 stat+read 这个文件。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 质检数据目录（settings.json / audit.jsonl / 备份都在这里）。 */
export const HOME_DIR = join(homedir(), '.dsh')
export const GUARD_DIR = join(HOME_DIR, 'quality-guard')
export const SETTINGS_FILE = join(GUARD_DIR, 'settings.json')
export const AUDIT_FILE = join(GUARD_DIR, 'audit.jsonl')
export const BACKUP_FILE = join(GUARD_DIR, 'settings.json.bak')

/** 面板里要显示的两个引擎条目的落点（只读探测其挂载状态）。 */
export const PROFILE_PATCH = join(HOME_DIR, 'profiles', 'desktop', 'cordis.patch.yml')

/** 判据默认值：抄用户的原话，不加解释。 */
export const DEFAULT_CRITERIA = [
  {
    id: 'conclusion-first',
    label: '先说核心结论',
    enabled: true,
    text: '最核心的那一个因素/结论放在最前面直接给出；不许先复述问题、先讲背景、先铺垫。',
  },
  {
    id: 'plain-words',
    label: '说人话，不用学术腔',
    enabled: true,
    text: '用最简单最直白的话说，像跟人当面讲话；不许学术腔、不许术语堆砌。（术语本身就是用户要的信息时不算违规）',
  },
  {
    id: 'no-tangents',
    label: '不旁生枝节',
    enabled: true,
    text: '用户没问的方向不要主动展开；限定条件、例外情形不要全铺一遍。',
  },
  {
    id: 'anchors',
    label: '数值必带出处',
    enabled: true,
    text: '出现具体数值或文献结论时，必须带可回查锚点（URL / DOI / PMID / arXiv / 文件路径 + 行号）。（这是用户明确要求的例外：省字不许省出处。）',
  },
  {
    id: 'multi-question',
    label: '多个问句逐条对应',
    enabled: true,
    text: '用户的问题里含多个问句时，按「问题1+回答1、问题2+回答2」的顺序逐条对应，不许混着说。',
  },
]

export const DEFAULT_EXCEPTIONS = [
  '用户这一轮明确要了「详细说 / 完整版 / 全部列出来」→ 长和细都不算违规，只看有没有答在点子上。',
  '用户在赶时间、只要一个数或一个名字 → 多一句解释就算违规。',
].join('\n')

/** 默认设置：跟 selfcheck-guard 的出厂默认一致（dryRun=true，先演习）。 */
export function defaults() {
  return {
    version: 1,
    enabled: true,
    dryRun: true,
    triggers: { minReplyChars: 0, maxReworks: 3, scoreThreshold: 70 },
    // v1.4.0：超时不再由插件自己截（引擎里那段 setTimeout 已删），这个键只为兼容老 patch 保留。
    judge: { timeoutMs: 60000, maxTokens: null, model: null },
    // 判官两次都拿不到裁定时的出口（v5 三值逻辑的 unknown）：
    // 'pass' ＝ 放行（旧行为，风险是漏判）；'rework' ＝ 打回重写（宁严不宽，v1.3.0 起为默认）。
    onUnknown: 'rework',
    // 判官的思考档位（v1.4.0）。'default' ＝ 一个字节都不发，让该 provider/model 用它自己的默认档。
    // 发档位是 v1.2~v1.3 的病根：本机 10 次「不认识这个档位」被拒、升档 7 次成功 0 次。
    // 仍然允许显式填 off/minimal/low/medium/high —— 那是给「想强制低思考省钱」的人留的开关。
    reasoningEffort: 'default',
    criteria: DEFAULT_CRITERIA.map((item) => ({ ...item })),
    exceptions: DEFAULT_EXCEPTIONS,
    auditFile: AUDIT_FILE.replace(/\\/g, '/'),
    updatedAt: null,
  }
}

/** 引擎认的档位值；'auto' 是老别名的残留，归一到 'default'。 */
export const EFFORT_VALUES = ['default', 'off', 'minimal', 'low', 'medium', 'high']

/** 字段说明：面板用它渲染「这一项在管什么」，引擎不看。 */
export const FIELD_HELP = {
  enabled: '总闸。关掉＝一条都不检查（对话照常，不花判官的钱）。',
  dryRun: '演习模式。开＝只判断、只记日志、不打回；关＝判不过就真的打回重写。',
  minReplyChars: '回复短于这个字数就跳过检查。0＝每条都查（连「好的」也查）。',
  maxReworks: '同一条回复最多被打回几次，防死循环。0＝永不回炉。',
  scoreThreshold: '判官打分的及格线（0-100）。低于它就算不过。',
  onUnknown: '判官两次都拿不到裁定（断流、空输出、上游 502）时怎么办。放行＝旧行为，风险是漏判；打回＝宁严不宽，会多花一轮。v1.3.0 起默认打回。',
  reasoningEffort: '留「跟随模型默认」＝一个字节都不发，由这家 API 自己决定用多深的思考。只有你想强行压低思考成本时才挑一个具体档位。',
  timeoutMs: '已停用：v1.4.0 起判官不再自己设截止，等上游回话为止。',
  criteria: '判官手里那张尺子。勾掉＝这一条不再检查。',
  exceptions: '例外情形：写在这里的，判官不按上面的判据算违规。一行一条。',
}

const MAX_TEXT = 2000
const MAX_EXCEPTIONS = 4000

function fail(message) {
  const error = new Error(message)
  error.code = 'INVALID_SETTINGS'
  throw error
}

function pickBool(value, field, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') fail(`${field} 必须是 true / false`)
  return value
}

function pickInt(value, field, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value)) fail(`${field} 必须是整数`)
  if (value < min || value > max) fail(`${field} 必须在 ${min}~${max} 之间`)
  return value
}

/**
 * 把外部交来的设置对象校验＋补齐成规范形状。
 * 未知字段直接丢弃（面板加字段时不会把引擎炸掉），非法值报人话错误。
 */
export function normalize(input) {
  if (input === undefined || input === null) return defaults()
  if (typeof input !== 'object' || Array.isArray(input)) fail('设置必须是一个对象')
  const base = defaults()
  const triggers = input.triggers ?? {}
  const judge = input.judge ?? {}
  if (typeof triggers !== 'object' || Array.isArray(triggers)) fail('triggers 必须是对象')
  if (typeof judge !== 'object' || Array.isArray(judge)) fail('judge 必须是对象')

  let model = null
  const rawModel = judge.model
  if (rawModel !== undefined && rawModel !== null) {
    if (typeof rawModel !== 'object' || Array.isArray(rawModel)) fail('判官模型必须写成 {provider, model} 或留空')
    const provider = typeof rawModel.provider === 'string' ? rawModel.provider.trim() : ''
    const modelName = typeof rawModel.model === 'string' ? rawModel.model.trim() : ''
    if (provider === '' && modelName === '') model = null
    else if (provider === '' || modelName === '') fail('判官模型要 provider 和 model 两个都填，或者都留空')
    else model = { provider, model: modelName }
  }

  const rawCriteria = input.criteria === undefined || input.criteria === null
    ? base.criteria
    : input.criteria
  if (!Array.isArray(rawCriteria)) fail('criteria 必须是数组')
  if (rawCriteria.length > 40) fail('判据最多 40 条')
  const seen = new Set()
  const criteria = rawCriteria.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) fail(`第 ${index + 1} 条判据必须是对象`)
    let id = typeof item.id === 'string' && item.id.trim() !== '' ? item.id.trim() : `c${index + 1}`
    if (seen.has(id)) id = `${id}-${index + 1}`
    seen.add(id)
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (text === '') fail(`第 ${index + 1} 条判据的正文是空的`)
    if (text.length > MAX_TEXT) fail(`第 ${index + 1} 条判据太长（上限 ${MAX_TEXT} 字）`)
    const label = typeof item.label === 'string' && item.label.trim() !== '' ? item.label.trim().slice(0, 60) : ''
    return { id, label, enabled: pickBool(item.enabled, `第 ${index + 1} 条判据的启用开关`, true), text }
  })
  if (criteria.length === 0) fail('至少要留一条判据（不然判官拿什么判）')
  if (!criteria.some((item) => item.enabled)) fail('至少要勾选一条判据')

  const exceptions = input.exceptions === undefined || input.exceptions === null ? '' : input.exceptions
  if (typeof exceptions !== 'string') fail('例外必须是文本')
  if (exceptions.length > MAX_EXCEPTIONS) fail(`例外太长（上限 ${MAX_EXCEPTIONS} 字）`)

  const auditFile = typeof input.auditFile === 'string' && input.auditFile.trim() !== ''
    ? input.auditFile.trim()
    : base.auditFile

  // maxTokens 只为兼容老 patch / 老 settings.json 而保留：v1.4.0 起引擎固定发 JUDGE_MAX_TOKENS(32768)，
  // 这里仍收一个数字当逃生舱（有人想故意压小来省钱的话，引擎照用）。
  const maxTokens = judge.maxTokens === undefined || judge.maxTokens === null
    ? null
    : pickInt(judge.maxTokens, '判官输出上限', null, 64, 32768)

  const rawEffort = typeof input.reasoningEffort === 'string' ? input.reasoningEffort.trim() : ''
  const reasoningEffort = rawEffort === 'auto' || rawEffort === ''
    ? 'default'
    : EFFORT_VALUES.includes(rawEffort) ? rawEffort : base.reasoningEffort

  return {
    version: 1,
    enabled: pickBool(input.enabled, '总开关', base.enabled),
    dryRun: pickBool(input.dryRun, '演习模式', base.dryRun),
    triggers: {
      minReplyChars: pickInt(triggers.minReplyChars, '最少字数', base.triggers.minReplyChars, 0, 20000),
      maxReworks: pickInt(triggers.maxReworks, '最多打回次数', base.triggers.maxReworks, 0, 10),
      scoreThreshold: pickInt(triggers.scoreThreshold, '及格线', base.triggers.scoreThreshold, 0, 100),
    },
    judge: {
      timeoutMs: pickInt(judge.timeoutMs, '判官超时', base.judge.timeoutMs, 1000, 120000),
      maxTokens,
      model,
    },
    criteria,
    exceptions: exceptions.trim(),
    onUnknown: input.onUnknown === 'rework' ? 'rework' : input.onUnknown === 'pass' ? 'pass' : base.onUnknown,
    // v1.4.0：默认 'default'＝一个字节都不发档位；'auto' 是老别名，归一过来。
    reasoningEffort,
    auditFile: auditFile.replace(/\\/g, '/'),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
  }
}

/**
 * 把设置拼成给判官看的那段判据文本。
 * 与 selfcheck-guard/index.mjs 里的同名片逻辑保持一致（引擎自带一份，避免跨包 import）。
 */
export function composeCriteria(settings) {
  const items = settings.criteria.filter((item) => item.enabled && item.text.trim() !== '')
  const lines = ['判据（任一条不满足即不合格）：']
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.text.trim()}`)
  })
  const exceptions = settings.exceptions
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => line !== '')
  if (exceptions.length > 0) {
    lines.push('', '例外：', ...exceptions.map((line) => `- ${line}`))
  }
  return lines.join('\n')
}
