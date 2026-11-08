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

/**
 * 面板里要显示的两个引擎条目的落点（只读探测其挂载状态）。
 *
 * v1.7.1：这里以前写死 `profiles/desktop/`。插件装到别的 profile（`web` / `tui` / 市场建的任意
 * profile）时，面板读的是一个跟它无关的文件，于是横幅会谎报「没有任何质检引擎在跑」。
 * 现在只给目录，由宿主半侧把所有 profile 都扫一遍（见 index.js 的 probeEngines）。
 */
export const PROFILES_DIR = join(HOME_DIR, 'profiles')

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

/** v1.7.0：判官提示词的出厂默认，跟 engine/index.mjs 里的常量逐字一致（避免跨包 import）。 */
export const DEFAULT_JUDGE_SYSTEM = [
  '你是一个质检员。你面前有「用户的问题」和「助手即将发出的回复」。',
  '你不评价内容是否正确、是否充分，只判定这段回复**读起来是否符合用户给出的判据**。',
  '判据没写的要求不算违规；判据的前提在本轮不成立时（比如回复里没出现数值、用户只问了一个问题），该条算满足。',
  '判不合格必须能指出回复里具体是哪句话违反了哪条判据；指不出具体句子就判合格。',
].join('\n')

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

/** 默认设置：跟 selfcheck-guard 的出厂默认一致（dryRun=true，先演习）。 */
export function defaults() {
  return {
    version: 1,
    enabled: true,
    dryRun: true,
    // v1.5.0：及格线 70 → 80（任一条 <6 分另外直接打回，但总分也要 80 才放行）。
    triggers: { minReplyChars: 0, maxReworks: 3, scoreThreshold: 80 },
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
    judgeSystem: DEFAULT_JUDGE_SYSTEM,
    judgeRules: DEFAULT_JUDGE_RULES,
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
  scoreThreshold: '判官打分的及格线（0-100）。低于它就算不过。另外任一条判据低于 6 分，不管总分多少都直接打回（v1.5.0 起）。',
  onUnknown: '判官两次都拿不到裁定（断流、空输出、上游 502）时怎么办。放行＝旧行为，风险是漏判；打回＝宁严不宽，会多花一轮。v1.3.0 起默认打回。',
  reasoningEffort: '留「跟随模型默认」＝一个字节都不发，由这家 API 自己决定用多深的思考。只有你想强行压低思考成本时才挑一个具体档位。',
  timeoutMs: '已停用：v1.4.0 起判官不再自己设截止，等上游回话为止。',
  criteria: '判官手里那张尺子。勾掉＝这一条不再检查。',
  exceptions: '例外情形：写在这里的，判官不按上面的判据算违规。一行一条。',
  judgeSystem: '判官的 system 消息（它是谁、只管什么、什么算违规）。框里就是判官实际用的全文，改完下一轮生效；不能留空。',
  judgeRules: '逐条打分的规则 + 六档量表。框里就是判官实际用的全文，想收紧给分就改这里；不能留空。',
}

const MAX_TEXT = 2000
const MAX_EXCEPTIONS = 4000
const MAX_JUDGE_PROMPT = 20000

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

/** v1.7.0：判官提示词两个字段。框里＝settings.json 里＝判官实际用的，三者逐字一致，不允许留空。
 *  只有「老版 settings.json 还没这两个字段」时才用出厂默认全文补齐（升级兼容，不是留空）。
 *  要恢复出厂默认请点面板的「恢复默认」，它会把默认全文重新写进 settings.json。 */
  const pickJudgePrompt = (value, label, fallback) => {
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'string') fail(`${label} 必须是文本`)
    if (value.trim() === '') fail(`${label} 不能留空：框里就是判官实际用的全文；要恢复出厂默认请点右上角的「恢复默认」`)
    if (value.length > MAX_JUDGE_PROMPT) fail(`${label} 太长（上限 ${MAX_JUDGE_PROMPT} 字）`)
    return value
  }
  const judgeSystem = pickJudgePrompt(input.judgeSystem, '判官 system 提示词', DEFAULT_JUDGE_SYSTEM)
  const judgeRules = pickJudgePrompt(input.judgeRules, '判官打分规则', DEFAULT_JUDGE_RULES)

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
    judgeSystem,
    judgeRules,
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
