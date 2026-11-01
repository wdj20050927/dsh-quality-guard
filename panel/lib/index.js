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
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {
  AUDIT_FILE,
  BACKUP_FILE,
  GUARD_DIR,
  PROFILE_PATCH,
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
    const tail = lines.slice(-limit)
    return tail.map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { error: '无法解析的一行', raw: line.slice(0, 400) }
      }
    })
  } catch {
    return []
  }
}

/**
 * 只读探测两套引擎在 profile patch 里的状态。
 * 只认「没被 # 注释掉的 - id: xxx」这一行，所以无需 YAML 解析。
 */
function probeEngines() {
  const result = {
    selfcheck: { id: 'selfcheck-guard', mounted: false },
    fork: { id: 'quality-review', mounted: false, enabled: false, maxRounds: null },
    conflict: false,
  }
  let text = ''
  try {
    text = readFileSync(PROFILE_PATCH, 'utf8')
  } catch {
    return result
  }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*#/.test(line)) continue
    if (/^\s*-\s*id:\s*selfcheck-guard\s*$/.test(line)) result.selfcheck.mounted = true
    if (/^\s*-\s*id:\s*quality-review\s*$/.test(line)) {
      result.fork.mounted = true
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
  result.conflict = result.selfcheck.mounted && result.fork.mounted && result.fork.enabled
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

function statePayload(limit = 20) {
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
    audit: readAudit(limit),
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
      sendJson(res, 200, statePayload(limit))
      return
    }
    if (req.method === 'GET' && route === '/audit') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 30) || 30, 1), 200)
      sendJson(res, 200, { ok: true, audit: readAudit(limit) })
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
    mount(ctx, 'ctx')
    return
  }
  logHost('ctx.webServer 没拿到 → 改用 ctx.inject 现开 scoped fiber')
  ctx.inject(['webServer'], (scoped) => {
    logHost(`scoped 就绪，scoped.webServer=${typeof (scoped && scoped.webServer)}`)
    mount(scoped, 'scoped')
  })
}

export default apply
