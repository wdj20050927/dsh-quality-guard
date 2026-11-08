/**
 * dsh-quality-guard —— 宿主半侧（Node）。
 *
 * 干什么：给「质检面板」提供同源 HTTP 接口，读写 %USERPROFILE%/.dsh/quality-guard/settings.json。
 * 不干什么：不判定、不调模型。真正的质检引擎是 selfcheck-guard（它自己每轮现读这个 json）。
 *
 * 为什么用 JSON 文件当接口而不是热改 cordis.patch.yml：
 *   patch 里改一个字符要重载整棵插件树；settings.json 是引擎每轮现读的，改完**下一轮就生效**，
 *   这正是用户要的「页面里手动改、立刻生效」。
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import {
  AUDIT_FILE,
  BACKUP_FILE,
  GUARD_DIR,
  HOME_DIR,
  PROFILES_DIR,
  SETTINGS_FILE,
  defaults,
  normalize,
} from './settings.js'

export const name = 'quality-guard'

/**
 * `export const inject` 在「profile patch 里按绝对路径挂载」这种形态下**不被采信**
 * —— 本机踩过三次：selfcheck-guard/index.mjs:286-300、dsh-workbuddy-relay/index.js:170-174。
 * 症状就是 apply 跑了（文件都写了）但 `ctx.webServer` 拿不到、路由静默没有。
 * 正解：apply 里用 `ctx.inject(['webServer'], scoped => …)` 现开一个带注入的 scoped fiber。
 */
export const inject = []

const API_PREFIX = '/quality-guard/api'
const MAX_BODY = 1024 * 1024
const HOST_LOG = GUARD_DIR.replace(/\\/g, '/') + '/host.log'

/** 落盘诊断：宿主半侧出问题时唯一能看见的痕迹（页面的 404 不会告诉你为什么）。 */
function logHost(line) {
  try {
    appendFileSync(HOST_LOG, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    // 日志写不出来就算了，不能因此炸掉宿主。
  }
}

/** 读 settings.json；坏文件/不存在 → 返回 undefined（调用方决定退路，绝不抛）。 */
function readSettingsFile() {
  try {
    if (!existsSync(SETTINGS_FILE)) return undefined
    return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
  } catch {
    return undefined
  }
}

function readAudit(limit) {
  try {
    if (!existsSync(AUDIT_FILE)) return []
    const raw = readFileSync(AUDIT_FILE, 'utf8')
    const lines = raw.split('\n').filter((line) => line.trim() !== '')
    const parsed = lines.map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { error: '无法解析的一行', raw: line.slice(0, 400) }
      }
    })
    /**
     * `judgeNth` = **这一轮对话里判官第几次出现**——就是 1、2、3 这种小数字，
     * 对应「原文被判一次 → 打回重写再判 → 再打回再判」（`rework` 0 → 1 → 2）。
     *
     * 两个坑：
     *   1. 不能拿整个会话累计 —— 那会数到几十，读的人根本对不上是哪一次打回。
     *      所以按 `session + turn` 分组，每组内部重新从 1 数。
     *   2. 不能拿 `turn` 顶替同一个意思 —— `turn` 是对话走到第几轮，和判官在这一轮
     *      出场几次是两件事：同一 turn 有几行，每行代表这一轮里的一次判断。
     * 计数必须基于**整份日志**（不能只数最后 N 行），否则分组会从中间截断、序号错位。
     */
    const ordinal = new Map()
    for (const row of parsed) {
      const id = normalizeSessionKey(row?.session)
      const turn = row?.turn === undefined || row?.turn === null ? '' : String(row.turn)
      const key = `${id}#${turn}`
      const nth = (ordinal.get(key) ?? 0) + 1
      ordinal.set(key, nth)
      row.judgeNth = nth
    }
    return parsed.slice(-limit)
  } catch {
    return []
  }
}

/**
 * 会话标题：审计行里只有 `session-<uuid>`，面板上光看一串 uuid 认不出是哪个对话。
 *
 * 两条路，先官方后自己解：
 *   1. 宿主有官方服务 `sessionQuery.readTitleSnapshots(ids)`，它折的是日志里**最后一条**
 *      `session/title` 事件（fork / 重命名都会再写一条），活跃会话还带缓存 —— 最快。
 *   2. 但那个服务只认**它还留着索引**的会话，老会话一律
 *      `SESSION_QUERY_SESSION_NOT_FOUND`（实测 22 个里只有 5 个能拿到）。这时退回自己
 *      切帧解日志（见下面 `SESSIONS_DIR` 那段），覆盖到 22/22，17 个会话约 250 ms。
 */
const TITLE_TTL = 5 * 60 * 1000
const TITLE_TIMEOUT = 8000
const titleCache = new Map()
let missingLogged = false

function normalizeSessionKey(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'undefined' || trimmed === 'null') return ''
  return trimmed.startsWith('session-') ? trimmed.slice('session-'.length) : trimmed
}

/**
 * 退路：`sessionQuery.readTitleSnapshots` 只认**它还留着索引**的会话，老会话一律
 * `SESSION_QUERY_SESSION_NOT_FOUND`（实测 22 个里只有 5 个能拿到标题）。而日志本身
 * 都还在 `<HOME>/.dsh/sessions/<workspace>/session-<uuid>/session.v4.jsonl.zstd` 里，
 * 直接切帧解 zstd 抠最后一条 `session/title` 就能补上。
 *
 * 为什么自己切帧：`zstdDecompressSync` 只解出第一帧，单文件是几百帧拼起来的。
 */
const SESSIONS_DIR = join(HOME_DIR, 'sessions')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_INDEX_TTL = 10 * 60 * 1000
let sessionIndex = null
let sessionIndexAt = 0

/** `<uuid>` → 会话目录的扁平索引（10 分钟重建一次；504 个目录扫一遍约 10 ms）。 */
function buildSessionIndex() {
  const index = new Map()
  let workspaces = []
  try {
    workspaces = readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return index
  }
  for (const workspace of workspaces) {
    let children = []
    try {
      children = readdirSync(join(SESSIONS_DIR, workspace.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const bare = normalizeSessionKey(child.name)
      if (bare === '' || index.has(bare)) continue
      index.set(bare, join(SESSIONS_DIR, workspace.name, child.name))
    }
  }
  return index
}

function findSessionDir(id) {
  const now = Date.now()
  if (sessionIndex === null || now - sessionIndexAt > SESSION_INDEX_TTL) {
    sessionIndex = buildSessionIndex()
    sessionIndexAt = now
  }
  return sessionIndex.get(id)
}

/** 多帧 zstd → 事件数组；坏行、坏帧都跳过，绝不抛。 */
function readSessionEvents(file) {
  let buf = null
  try {
    buf = readFileSync(file)
  } catch {
    return []
  }
  const parts = []
  let offset = 0
  while (offset < buf.length) {
    const start = buf.indexOf(ZSTD_MAGIC, offset)
    if (start === -1) break
    let next = buf.indexOf(ZSTD_MAGIC, start + 4)
    let done = false
    while (true) {
      const end = next === -1 ? buf.length : next
      try {
        parts.push(zstdDecompressSync(buf.subarray(start, end)))
        offset = end
        done = true
        break
      } catch {
        if (next === -1) break
        next = buf.indexOf(ZSTD_MAGIC, next + 4)
      }
    }
    if (!done) {
      if (next === -1) break
      offset = next
    }
  }
  const events = []
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 半行/坏行跳过
    }
  }
  return events
}

/** 读一个会话日志的最后一条 `session/title`；没有就是空串。 */
function readTitleFromDisk(id) {
  const dir = findSessionDir(id)
  if (dir === undefined) return ''
  const events = readSessionEvents(join(dir, 'session.v4.jsonl.zstd'))
  // 取最后一条：fork / 重命名都会再写一条，早的那条是 seed 时复制过来的旧标题。
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'session/title' && typeof event?.data?.title === 'string' && event.data.title !== '') {
      return event.data.title
    }
  }
  return ''
}

/**
 * 可选服务，只能 `ctx.get(...)` 现取：
 * 把 `sessionQuery` 写进 `ctx.inject([...])` 会变成硬依赖——老版本宿主没有这个服务时，
 * 整块回调不跑，`webServer` 也跟着死，面板直接 404（本文件顶部那条注释记的就是这个坑）。
 */
function resolveSessionQuery() {
  for (const scope of [serviceScope, rootScope]) {
    if (scope === null || scope === undefined) continue
    try {
      const service = scope.get?.('sessionQuery') ?? scope.sessionQuery
      if (typeof service?.readTitleSnapshots === 'function') return service
    } catch (error) {
      logHost(`取 sessionQuery 抛错：${String((error && error.message) || error)}`)
    }
  }
  // 只抱怨一次：面板每 5 分钟会重试一轮，每次都写会让日志淹掉别的诊断。
  if (!missingLogged) {
    missingLogged = true
    logHost('sessionQuery 不可用（面板只显示会话短号）')
  }
  return null
}

async function warmTitles(ids) {
  const stale = ids.filter((id) => {
    const hit = titleCache.get(id)
    return hit === undefined || Date.now() - hit.at > TITLE_TTL
  })
  if (stale.length === 0) return
  const service = resolveSessionQuery()
  /**
   * 超时护栏：这一路是「读日志折标题」，冷会话多了会慢。面板 15 s 会超时，
   * 但**没有标题也不能让整张表出不来**——超时就直接按「没有标题」渲染。
   */
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT)
  try {
    if (service !== null) {
      /**
       * 传**归一后**的 id（去掉 `session-` 前缀）：日志里的 `SessionHeader.id` 就是这个形态，
       * 而审计行有的带前缀有的是裸 uuid（历史原因，30 条裸的），统一成裸的才都对得上。
       */
      const results = await service.readTitleSnapshots(stale, controller.signal)
      const now = Date.now()
      for (const item of Array.isArray(results) ? results : []) {
        const id = normalizeSessionKey(item?.sessionId)
        if (id === '') continue
        const title = item?.status === 'fulfilled' ? item?.value?.title?.title : ''
        if (typeof title === 'string' && title !== '') titleCache.set(id, { title, at: now })
      }
    }
    /** 服务查不到的（老会话大多 `SESSION_QUERY_SESSION_NOT_FOUND`）退回自己解日志。 */
    const missing = stale.filter((id) => !titleCache.has(id))
    if (missing.length > 0) {
      const started = Date.now()
      const now = Date.now()
      let hit = 0
      for (const id of missing) {
        if (controller.signal.aborted) break
        const title = readTitleFromDisk(id)
        if (title !== '') hit += 1
        // 查不到也写空串：否则每刷新一次都要把这批几百 MB 的日志再解一遍。
        titleCache.set(id, { title, at: now })
      }
      logHost(`磁盘退路：${missing.length} 个会话 → 命中 ${hit}，耗时 ${Date.now() - started}ms`)
    }
  } catch (error) {
    logHost(`取标题失败：${String((error && error.message) || error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/** 给审计行补上 `sessionId`（短号）与 `sessionTitle`（拿不到就是空串）。 */
async function withTitles(rows) {
  const ids = []
  for (const row of rows) {
    const id = normalizeSessionKey(row?.session)
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }
  if (ids.length > 0) await warmTitles(ids)
  return rows.map((row) => {
    if (row === null || typeof row !== 'object') return row
    // 出错行（判官超时之类）也照样标上对话：它同样属于某个会话，读者更该知道是哪个。
    const id = normalizeSessionKey(row.session)
    const title = titleCache.get(id)?.title ?? ''
    return { ...row, sessionId: id, sessionTitle: title }
  })
}

/**
 * 只读探测两套引擎在 profile patch 里的状态。
 * 只认「没被 # 注释掉的 - id: xxx」这一行，所以无需 YAML 解析。
 *
 * v1.7.1：扫 `~/.dsh/profiles/*` 下所有 profile，而不是写死 `desktop`。
 * 引擎可能挂在任意一个 profile 里（插件自己装到 `web` 也会挂），只认一个目录会误报「没引擎在跑」。
 * 返回 `patchFiles` 让页面能说清是在哪个文件里找到的。
 *
 * v1.7.2：除了 profile 自己的 `cordis.patch.yml`，还要读**装进那个 profile 的 bundle 自带的 patch**——
 * 一条命令装完时引擎是 bundle patch 挂的，profile 那个文件里根本没有 `- id: selfcheck-guard`，
 * 只扫 profile 会给刚装好的人报「没有引擎在跑」。
 */
function profilePatches() {
  const found = []
  let names = []
  try {
    names = readdirSync(PROFILES_DIR)
  } catch {
    return found
  }
  for (const profile of names.sort()) {
    const dir = join(PROFILES_DIR, profile)
    const own = join(dir, 'cordis.patch.yml')
    try {
      if (statSync(own).isFile()) found.push({ profile, file: own, text: readFileSync(own, 'utf8') })
    } catch {
      // 这个 profile 没有 patch 文件，跳过。
    }
    const bundled = join(dir, 'node_modules', 'dsh-quality-guard', 'panel', 'cordis.patch.yml')
    try {
      if (statSync(bundled).isFile()) {
        found.push({ profile, file: bundled, text: readFileSync(bundled, 'utf8') })
      }
    } catch {
      // 这个 profile 没装本插件，跳过。
    }
  }
  return found
}

function probeEngines() {
  const result = {
    selfcheck: { id: 'selfcheck-guard', mounted: false },
    fork: { id: 'quality-review', mounted: false, enabled: false, maxRounds: null },
    conflict: false,
    patchFiles: [],
  }
  const patches = profilePatches()
  result.patchFiles = patches.map((entry) => entry.file)
  const where = { selfcheck: [], fork: [] }
  for (const patch of patches) scanEngines(patch.text, result, where, patch.profile)
  if (where.selfcheck.length > 0) result.selfcheck.profiles = where.selfcheck
  if (where.fork.length > 0) result.fork.profiles = where.fork
  result.conflict = result.selfcheck.mounted && result.fork.mounted && result.fork.enabled
  return result
}

/** 扫一段 patch 文本，把命中写进 result，并把命中的 profile 名记到 where。 */
function scanEngines(text, result, where, profile) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*#/.test(line)) continue
    if (/^\s*-\s*id:\s*selfcheck-guard\s*$/.test(line)) {
      result.selfcheck.mounted = true
      if (!where.selfcheck.includes(profile)) where.selfcheck.push(profile)
    }
    if (/^\s*-\s*id:\s*quality-review\s*$/.test(line)) {
      result.fork.mounted = true
      if (!where.fork.includes(profile)) where.fork.push(profile)
      // 只认这一条自己的 config.enabled（第一个），不能只看「最后一条 enabled」——
      // fork 的 sop.enabled / aspects.* 里也各有 enabled，取最后一条会把 true 当成引擎开关。
      const idIndent = line.length - line.trimStart().length
      let sawEnabled = false
      for (let k = i + 1; k < Math.min(i + 30, lines.length); k += 1) {
        const next = lines[k]
        if (/^\s*#/.test(next)) continue
        const indent = next.length - next.trimStart().length
        if (indent <= idIndent) break
        if (!sawEnabled) {
          const enabled = /^\s*enabled:\s*(true|false)\s*$/.exec(next)
          if (enabled !== null) {
            result.fork.enabled = enabled[1] === 'true'
            sawEnabled = true
            continue
          }
        }
        if (result.fork.maxRounds === null) {
          const rounds = /^\s*maxRounds:\s*(\d+)\s*$/.exec(next)
          if (rounds !== null) result.fork.maxRounds = Number(rounds[1])
        }
      }
    }
  }
  return result
}

function fileInfo(path) {
  try {
    const stat = statSync(path)
    return { path, exists: true, size: stat.size, mtime: stat.mtime.toISOString() }
  } catch {
    return { path, exists: false, size: 0, mtime: null }
  }
}

/** 原子写：先写 .tmp 再 rename，避免引擎读到半个 JSON。旧文件留一份 .bak。 */
function writeSettings(settings) {
  mkdirSync(GUARD_DIR, { recursive: true })
  if (existsSync(SETTINGS_FILE)) {
    try {
      copyFileSync(SETTINGS_FILE, BACKUP_FILE)
    } catch {
      // 备份失败不该挡住保存。
    }
  }
  const payload = `${JSON.stringify({ ...settings, updatedAt: new Date().toISOString() }, null, 2)}\n`
  const tmp = `${SETTINGS_FILE}.tmp`
  writeFileSync(tmp, payload, 'utf8')
  renameSync(tmp, SETTINGS_FILE)
  return readSettingsFile()
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 当前 scoped fiber 的 llm 服务（v1.4.0 新增给面板填模型用）。
 *
 * 为什么**每次请求现取**而不是 apply 时就抓好：
 *   `llm` 是宿主后挂的服务，apply 那一刻它可能还没就绪；而 `ctx.inject(['llm'], …)` 在依赖缺失时
 *   **整块回调都不会跑**——把 webServer 一起拖死，面板会整个 404。所以 webServer 单独 inject，
 *   llm 每次请求时 try 一次，拿不到就老实回 available:false，面板退回手填。
 */
let serviceScope = null
/** apply 拿到的根 ctx。scoped fiber 是 webServer 那一层，`sessionQuery` 在根上也可能可取。 */
let rootScope = null

function resolveLlm() {
  try {
    const llm = serviceScope?.get?.('llm') ?? serviceScope?.llm
    return typeof llm?.stream === 'function' ? llm : null
  } catch {
    return null
  }
}

/** 把 llm.listProviders() / listModels() 收成面板能直接渲染的下拉数据。 */
async function modelsPayload() {
  const llm = resolveLlm()
  if (llm === null) return { ok: true, available: false, providers: [] }
  let providers = []
  try {
    providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  } catch {
    return { ok: true, available: false, providers: [] }
  }
  const out = []
  for (const provider of Array.isArray(providers) ? providers : []) {
    const id = typeof provider?.id === 'string' ? provider.id : ''
    if (id === '') continue
    let models = []
    try {
      models = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
    } catch {
      models = []
    }
    out.push({
      id,
      name: typeof provider?.name === 'string' && provider.name !== '' ? provider.name : id,
      models: (Array.isArray(models) ? models : []).map((model) => ({
        id: typeof model?.id === 'string' ? model.id : '',
        name: typeof model?.name === 'string' && model.name !== '' ? model.name : (typeof model?.id === 'string' ? model.id : ''),
      })).filter((model) => model.id !== ''),
    })
  }
  return { ok: true, available: out.length > 0, providers: out }
}

/** 单个模型支持哪些思考档位 —— 直接问宿主，绝不在插件里猜。 */
async function modelInfoPayload(provider, model) {
  const llm = resolveLlm()
  if (llm === null || provider === '' || model === '') {
    return { ok: true, available: false, efforts: [], defaultEffort: null }
  }
  if (typeof llm.resolveModelInfo !== 'function') return { ok: true, available: false, efforts: [], defaultEffort: null }
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const reasoning = info?.reasoning
    const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
    return {
      ok: true,
      available: efforts.length > 0,
      efforts: efforts.map((effort) => ({
        id: typeof effort?.id === 'string' ? effort.id : '',
        name: typeof effort?.name === 'string' && effort.name !== '' ? effort.name : (typeof effort?.id === 'string' ? effort.id : ''),
      })).filter((effort) => effort.id !== ''),
      defaultEffort: typeof reasoning?.defaultEffort === 'string' ? reasoning.defaultEffort : null,
    }
  } catch (error) {
    return { ok: true, available: false, efforts: [], defaultEffort: null, note: String((error && error.message) || error) }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function statePayload(limit = 20) {
  let current = readSettingsFile()
  let degraded = false
  try {
    current = normalize(current)
  } catch {
    current = defaults()
    degraded = true
  }
  return {
    ok: true,
    degraded,
    settings: current,
    defaults: defaults(),
    engines: probeEngines(),
    files: {
      settings: fileInfo(SETTINGS_FILE),
      audit: fileInfo(AUDIT_FILE),
      backup: fileInfo(BACKUP_FILE),
    },
    audit: await withTitles(readAudit(limit)),
    now: new Date().toISOString(),
  }
}

/**
 * 一个裸 node handler。webServer.register 的 handler 就是 (req, res)。
 */
async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = url.pathname.slice(API_PREFIX.length) || '/'
  try {
    if (req.method === 'GET' && (route === '/state' || route === '/')) {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), 200)
      sendJson(res, 200, await statePayload(limit))
      return
    }
    if (req.method === 'GET' && route === '/audit') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 30) || 30, 1), 200)
      sendJson(res, 200, { ok: true, audit: await withTitles(readAudit(limit)) })
      return
    }
    if (req.method === 'GET' && route === '/models') {
      sendJson(res, 200, await modelsPayload())
      return
    }
    if (req.method === 'GET' && route === '/model-info') {
      const provider = String(url.searchParams.get('provider') ?? '').trim()
      const model = String(url.searchParams.get('model') ?? '').trim()
      sendJson(res, 200, await modelInfoPayload(provider, model))
      return
    }
    if (req.method === 'POST' && route === '/settings') {
      const raw = await readBody(req)
      const parsed = JSON.parse(raw === '' ? '{}' : raw)
      const next = normalize(parsed.settings ?? parsed)
      const saved = writeSettings(next)
      sendJson(res, 200, { ok: true, settings: normalize(saved), engines: probeEngines() })
      return
    }
    if (req.method === 'POST' && route === '/reset') {
      const saved = writeSettings(defaults())
      sendJson(res, 200, { ok: true, settings: normalize(saved), engines: probeEngines() })
      return
    }
    if (req.method === 'POST' && route === '/restore-backup') {
      if (!existsSync(BACKUP_FILE)) {
        sendJson(res, 404, { ok: false, error: '还没有备份文件' })
        return
      }
      const restored = normalize(JSON.parse(readFileSync(BACKUP_FILE, 'utf8')))
      const saved = writeSettings(restored)
      sendJson(res, 200, { ok: true, settings: normalize(saved), engines: probeEngines() })
      return
    }
    sendJson(res, 404, { ok: false, error: `没有这个接口：${req.method} ${route}` })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

/** 第一次加载就把默认设置落盘，省得引擎和面板各猜一套默认值。 */
export function apply(ctx) {
  logHost(`apply start pid=${process.pid}`)
  rootScope = ctx
  try {
    mkdirSync(GUARD_DIR, { recursive: true })
  } catch {
    // 目录建不出来时，后面的读写会各自报错，这里不炸整个宿主。
  }
  if (!existsSync(SETTINGS_FILE)) {
    try {
      writeSettings(defaults())
      logHost('settings.json 已写默认值')
    } catch (error) {
      logHost(`写默认设置失败：${String((error && error.message) || error)}`)
    }
  }

  const mount = (scope, how) => {
    scope.effect(() => {
      let dispose
      try {
        dispose = scope.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle })
        logHost(`webServer.register ok via ${how}`)
      } catch (error) {
        logHost(`webServer.register FAILED via ${how}: ${String((error && error.message) || error)}`)
        throw error
      }
      return () => {
        logHost(`dispose via ${how}`)
        if (typeof dispose === 'function') dispose()
      }
    }, 'quality-guard: settings api')
  }

  // 探测 ctx.webServer 本身就会抛（「cannot get property ... without inject」），所以必须包起来。
  let direct = false
  try {
    direct = Boolean(ctx.webServer)
  } catch (error) {
    logHost(`读 ctx.webServer 抛错（预期内）：${String((error && error.message) || error)}`)
  }

  if (direct) {
    logHost('ctx.webServer 直接可用')
    serviceScope = ctx
    mount(ctx, 'ctx')
    return
  }
  logHost('ctx.webServer 没拿到 → 改用 ctx.inject 现开 scoped fiber')
  ctx.inject(['webServer'], (scoped) => {
    serviceScope = scoped
    logHost(`scoped 就绪，scoped.webServer=${typeof (scoped && scoped.webServer)}`)
    mount(scoped, 'scoped')
  })
}

export default apply
