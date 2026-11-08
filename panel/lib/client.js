/**
 * dsh-quality-guard —— 客户端半侧（浏览器 bundle，手写 JS，无构建）。
 *
 * 两份东西：
 *   ① 侧边栏面板列表里的一行（表情符号级别的图形，壳自己画按钮/悬停/选中态）
 *   ② 点开后在主栏渲染的「质检」页面：触发条件 + 判据，改完点保存写进 settings.json，
 *      引擎下一轮现读，所以**不用重载、不用重启**。
 *
 * 为什么数据走 HTTP 而不是槽位注入：主栏 slot 每次切换都会卸载这棵 React 树，
 * 设置必须活在一个两边都看得见的文件里（settings.json），面板只当编辑器。
 */

window.__ModuleLoader__.load({
  id: 'dsh-quality-guard',
  factory: (require) => {
    const module = { exports: {} }
    let React = null
    try {
      React = require('react')
    } catch {
      React = null
    }
    const h = React === null ? null : React.createElement

    const NS = 'dsh-quality-guard'
    const PANEL_ID = 'quality-guard'
    /** 侧边栏行序：插件 0、自动化任务 10、看板 20、技能中心 30、ThoughtDAG 30 → 质检排 40。 */
    const PANEL_ORDER = 40
    const API_ROOT = '/quality-guard/api'
    /** 自带样式用「有主」的 <style>，重复加载时复用上一次的 sheet。 */
    const CSS_ID = `${NS}/client.css`
    const CSS = `
.qg-root {
  --qg-gap: 14px;
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  padding: 0 max(24px, 5vw) 120px;
  padding-top: calc(var(--dsh-frame-top-clearance, 12px) + 28px);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 14px;
  line-height: 1.65;
  background: var(--dsw-alias-bg-base);
}
.qg-wrap { max-width: 880px; margin: 0 auto; }
.qg-head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
.qg-head h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: .02em; }
.qg-head p { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.qg-head-actions { margin-left: auto; display: flex; gap: 8px; flex: none; }
.qg-banner {
  display: flex; gap: 10px; align-items: flex-start;
  border-radius: 10px; padding: 10px 14px; margin-bottom: 18px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  font-size: 13px;
}
.qg-banner b { font-weight: 600; }
.qg-banner.is-ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); }
.qg-banner.is-warn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent); }
.qg-banner.is-bad { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); }
.qg-banner.is-idle { color: var(--dsw-alias-label-secondary); }
.qg-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 7px; flex: none; background: var(--dsw-alias-state-idle-primary); }
.qg-dot.ok { background: var(--dsw-alias-state-success-primary); }
.qg-dot.warn { background: var(--dsw-alias-state-warn-primary); }
.qg-dot.bad { background: var(--dsw-alias-state-error-primary); }
.qg-section {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 16px 18px;
  margin-bottom: var(--qg-gap);
}
.qg-section > header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.qg-section > header h2 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .04em; }
.qg-section > header span { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.qg-row {
  display: flex; align-items: center; gap: 12px;
  padding: 9px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1);
}
.qg-row:last-child { border-bottom: 0; }
.qg-row-main { flex: 1; min-width: 0; }
.qg-row-title { font-size: 13.5px; }
.qg-row-help { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
.qg-switch {
  flex: none; width: 42px; height: 24px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-3);
  position: relative; transition: background .16s ease, border-color .16s ease;
  padding: 0;
}
.qg-switch::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground, #fff);
  box-shadow: 0 1px 3px rgba(0,0,0,.28);
  transition: transform .16s ease;
}
.qg-switch.on { background: var(--dsw-alias-state-business-primary); border-color: transparent; }
.qg-switch.on::after { transform: translateX(18px); }
.qg-switch:disabled { opacity: .5; cursor: default; }
.qg-num {
  flex: none; width: 96px; text-align: right;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2));
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; padding: 5px 9px; outline: none;
}
.qg-num:focus { border-color: var(--dsw-alias-state-business-primary); }
.qg-select {
  flex: none; min-width: 150px; max-width: 230px;
  font-family: inherit; font-size: 13px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2));
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; padding: 5px 9px; outline: none; cursor: pointer;
}
.qg-select:focus { border-color: var(--dsw-alias-state-business-primary); }
.qg-select:disabled { opacity: .5; cursor: default; }
.qg-unit { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 12px; width: 26px; }
.qg-choice { flex: none; display: flex; gap: 6px; }
.qg-choice-btn {
  font-size: 12px; padding: 5px 10px; border-radius: 8px; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2));
  border: 1px solid var(--dsw-alias-border-l2);
  font-family: inherit;
}
.qg-choice-btn.on {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-bg-layer-3);
}
.qg-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;
  background: var(--dsw-alias-bg-base);
}
.qg-card.is-off { opacity: .55; }
.qg-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.qg-card-no {
  flex: none; width: 20px; height: 20px; border-radius: 6px; font-size: 11px;
  display: grid; place-items: center; font-variant-numeric: tabular-nums;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary);
}
.qg-label-input {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 600;
  background: transparent; border: 1px solid transparent; border-radius: 6px;
  padding: 3px 6px; color: inherit; outline: none; font-family: inherit;
}
.qg-label-input:hover { border-color: var(--dsw-alias-border-l2); }
.qg-label-input:focus { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-layer-2); }
.qg-text {
  width: 100%; box-sizing: border-box; resize: vertical; min-height: 58px;
  font-family: inherit; font-size: 13px; line-height: 1.6;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; padding: 8px 10px; outline: none;
}
.qg-text:focus { border-color: var(--dsw-alias-state-business-primary); }
.qg-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.qg-btn {
  font-family: inherit; font-size: 13px; cursor: pointer;
  border-radius: 8px; padding: 6px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  transition: background .14s ease, border-color .14s ease;
}
.qg-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.qg-btn:disabled { opacity: .5; cursor: default; }
.qg-btn.primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent; font-weight: 600;
}
.qg-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.qg-btn.danger { color: var(--dsw-alias-label-error); }
.qg-btn.tiny { padding: 3px 8px; font-size: 12px; }
.qg-audit { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.qg-audit th, .qg-audit td {
  text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1);
  vertical-align: top;
}
.qg-audit th { color: var(--dsw-alias-label-tertiary); font-weight: 500; }
.qg-audit td.num { font-variant-numeric: tabular-nums; font-family: var(--ds-font-family-code, ui-monospace, monospace); }
.qg-audit td:last-child { min-width: 220px; }
.qg-session { display: flex; flex-direction: column; gap: 1px; max-width: 220px; }
.qg-session-title {
  color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.qg-session-id {
  color: var(--dsw-alias-label-tertiary); font-size: 11px;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
}
.qg-muted { color: var(--dsw-alias-label-tertiary); }
.qg-tag {
  display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11.5px;
  border: 1px solid var(--dsw-alias-border-l2);
}
.qg-tag.pass { color: var(--dsw-alias-state-success-primary); }
.qg-tag.fail { color: var(--dsw-alias-label-error); }
.qg-tag.hold { color: var(--dsw-alias-state-warn-primary); }
.qg-empty { color: var(--dsw-alias-label-tertiary); font-size: 12.5px; padding: 6px 0; }
.qg-meta { color: var(--dsw-alias-label-tertiary); font-size: 12px; font-family: var(--ds-font-family-code, ui-monospace, monospace); word-break: break-all; }
.qg-foot {
  position: sticky; bottom: 0; margin-top: 4px;
  display: flex; align-items: center; gap: 12px;
  padding: 12px 18px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 88%, transparent);
  backdrop-filter: blur(8px);
}
.qg-foot .qg-state { font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.qg-foot .qg-state.dirty { color: var(--dsw-alias-state-warn-primary); }
.qg-foot .qg-state.bad { color: var(--dsw-alias-label-error); }
.qg-foot .qg-state.ok { color: var(--dsw-alias-state-success-primary); }
.qg-spacer { flex: 1; }
.qg-err { color: var(--dsw-alias-label-error); font-size: 12.5px; margin-top: 6px; }
`

    /** 侧边栏上的图形。壳负责按钮、悬停、选中态；这个组件只画图。 */
    function PanelIcon({ size }) {
      return h(
        'svg',
        {
          'data-dsh-panel-entry': PANEL_ID,
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M8 1.9 13 3.6v4.2c0 3-2.1 5.3-5 6.3-2.9-1-5-3.3-5-6.3V3.6z' }),
        h('path', { d: 'm5.9 7.9 1.5 1.5 2.9-3' }),
      )
    }

    /** `new URL(path.slice(1), document.baseURI)` —— 反代带前缀时也指向正确位置。 */
    function resolveApi(path) {
      if (!path.startsWith('/')) return path
      if (typeof document === 'undefined') return path
      try {
        return new URL(path.slice(1), document.baseURI).href
      } catch {
        return path
      }
    }

    async function request(path, init) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      try {
        const response = await fetch(resolveApi(path), {
          ...init,
          credentials: 'same-origin',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', ...(init && init.headers) },
        })
        const text = await response.text()
        let body = null
        try {
          body = text === '' ? null : JSON.parse(text)
        } catch {
          throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`)
        }
        if (!response.ok || (body && body.ok === false)) {
          throw new Error((body && body.error) || `HTTP ${response.status}`)
        }
        return body
      } finally {
        clearTimeout(timer)
      }
    }

    const api = {
      state: () => request(`${API_ROOT}/state`),
      save: (settings) => request(`${API_ROOT}/settings`, { method: 'POST', body: JSON.stringify({ settings }) }),
      reset: () => request(`${API_ROOT}/reset`, { method: 'POST', body: '{}' }),
      restore: () => request(`${API_ROOT}/restore-backup`, { method: 'POST', body: '{}' }),
      // v1.4.0 宿主新加的两个只读接口：可选模型清单、单个模型的思考档位。
      models: () => request(`${API_ROOT}/models`),
      modelInfo: (provider, model) =>
        request(`${API_ROOT}/model-info?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`),
    }

    /** 把服务器给的设置拷成可编辑草稿：数字转字符串，免得输入中途被判成非法。 */
    function toDraft(settings) {
      return {
        enabled: settings.enabled,
        dryRun: settings.dryRun,
        triggers: {
          minReplyChars: String(settings.triggers.minReplyChars),
          maxReworks: String(settings.triggers.maxReworks),
          scoreThreshold: String(settings.triggers.scoreThreshold),
        },
        judge: {
          timeoutMs: String(settings.judge.timeoutMs),
          model: settings.judge.model,
        },
        criteria: settings.criteria.map((item) => ({ ...item })),
        exceptions: settings.exceptions,
        judgeSystem: settings.judgeSystem ?? '',
        judgeRules: settings.judgeRules ?? '',
        onUnknown: settings.onUnknown === 'rework' ? 'rework' : 'pass',
        reasoningEffort: settings.reasoningEffort ?? 'default',
      }
    }

    /** 草稿 → 要提交的对象：数字字段在这里转回整数，非法值当场报人话。 */
    function fromDraft(draft) {
      const int = (raw, name, min, max) => {
        const value = Number(String(raw).trim())
        if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`${name} 要填整数`)
        if (value < min || value > max) throw new Error(`${name} 要在 ${min}~${max} 之间`)
        return value
      }
      // v1.7.0：框里＝判官实际用的全文，不允许留空（后端 normalize 也会再拦一道）。
      const requireJudgePrompt = (raw, label) => {
        if (typeof raw !== 'string' || raw.trim() === '') {
          throw new Error(`${label} 不能留空：框里就是判官实际用的全文；要恢复出厂默认请点右上角的「恢复默认」`)
        }
        return raw
      }
      const criteria = draft.criteria
        .filter((item) => item.text.trim() !== '')
        .map((item, index) => ({
          id: item.id || `c${index + 1}`,
          label: (item.label || '').trim(),
          enabled: item.enabled !== false,
          text: item.text.trim(),
        }))
      if (criteria.length === 0) throw new Error('至少要留一条有内容的判据')
      if (!criteria.some((item) => item.enabled)) throw new Error('至少要勾选一条判据')
      return {
        enabled: draft.enabled,
        dryRun: draft.dryRun,
        triggers: {
          minReplyChars: int(draft.triggers.minReplyChars, '最少字数', 0, 20000),
          maxReworks: int(draft.triggers.maxReworks, '最多打回次数', 0, 10),
          scoreThreshold: int(draft.triggers.scoreThreshold, '及格线', 0, 100),
        },
        judge: {
          timeoutMs: int(draft.judge.timeoutMs, '判官超时', 1000, 120000),
          model: draft.judge.model,
        },
        criteria,
        exceptions: draft.exceptions,
        judgeSystem: requireJudgePrompt(draft.judgeSystem, '判官 system 提示词'),
        judgeRules: requireJudgePrompt(draft.judgeRules, '判官打分规则'),
        onUnknown: draft.onUnknown === 'rework' ? 'rework' : 'pass',
        // v1.4.0：档位由人挑，'default' ＝ 一个字节都不发（老版本的 'auto' 已被归一到它）。
        reasoningEffort: draft.reasoningEffort,
      }
    }

    /** 档位下拉的取值，跟 panel/lib/settings.js 的 EFFORT_VALUES 保持一致（这里不能 import）。 */
    const EFFORT_OPTIONS = [
      { value: 'default', label: '跟随该模型默认（不发送）' },
      { value: 'off', label: 'off · 不思考' },
      { value: 'minimal', label: 'minimal · 最低' },
      { value: 'low', label: 'low · 低' },
      { value: 'medium', label: 'medium · 中' },
      { value: 'high', label: 'high · 高' },
    ]

    /** 宿主报了档位就只列它真支持的那几档；没报就退回全量六档。 */
    function effortOptions(reported, current) {
      const known = new Map(EFFORT_OPTIONS.map((option) => [option.value, option.label]))
      const out = [EFFORT_OPTIONS[0]]
      for (const effort of reported) {
        if (!effort || effort.id === 'default') continue
        out.push({
          value: effort.id,
          label: known.get(effort.id) || `${effort.id} · ${effort.name || effort.id}`,
        })
      }
      // 当前设置里的档位不在这个模型报的范围内时也留一格，不然下拉会显示成空。
      if (typeof current === 'string' && current !== 'default' && !out.some((option) => option.value === current)) {
        out.push({ value: current, label: `${current}（当前设置，该模型没报这一档）` })
      }
      return out
    }

    const HELP = {
      enabled: '总闸。关掉＝一条都不检查，对话照常，不花判官的钱。',
      dryRun: '演习模式。开＝只判断、只记录、不打回；关＝判不过就真的打回重写。',
      minReplyChars: '回复短于这个字数就跳过。0＝每条都查（连「好的」也查）。',
      maxReworks: '同一条回复最多被打回几次，防死循环。0＝永不回炉。',
      scoreThreshold: '判官打分（0-100）低于这条线就算不过。另外任一条判据低于 6 分，不管总分多少都直接打回。',
      onUnknown: '判官两次都拿不到裁定（超时、断流、空输出）时怎么办。放行＝旧行为，风险是漏判；打回＝宁严不宽，会多花一轮。',
      judgeAuto: '默认一个字节都不发，让这家 API 用它自己的默认档；只有你想强行压低时才挑一档。输出上限固定 32768，不用填。',
      judgeModel: '跟当前会话同一条线＝不指定，让判官走你正在用的那条模型；也可以从下拉里挑一个别的。',
      timeoutMs: 'v1.4.0 起判官不再自己设截止，等上游回话为止。',
      judgeSystem: '判官的 system 消息：它是谁、只管什么、什么算违规。这个框里就是判官实际用的全文，改完下一轮生效；不能留空。',
      judgeRules: '逐条打分的规则 + 0/2/4/6/8/10 六档量表；框里就是判官实际用的全文，想收紧给分就改这里；不能留空。',
    }

    function Switch({ checked, onChange, disabled }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        className: `qg-switch${checked ? ' on' : ''}`,
        disabled: disabled === true,
        onClick: () => onChange(!checked),
      })
    }

    function NumberRow({ title, help, value, min, max, unit, onChange }) {
      return h(
        'div',
        { className: 'qg-row' },
        h(
          'div',
          { className: 'qg-row-main' },
          h('div', { className: 'qg-row-title' }, title),
          help ? h('div', { className: 'qg-row-help' }, help) : null,
        ),
        h('input', {
          className: 'qg-num',
          type: 'number',
          min,
          max,
          value,
          onChange: (event) => onChange(event.target.value),
        }),
        h('span', { className: 'qg-unit' }, unit || ''),
      )
    }

    function ToggleRow({ title, help, checked, onChange }) {
      return h(
        'div',
        { className: 'qg-row' },
        h(
          'div',
          { className: 'qg-row-main' },
          h('div', { className: 'qg-row-title' }, title),
          help ? h('div', { className: 'qg-row-help' }, help) : null,
        ),
        h(Switch, { checked, onChange }),
      )
    }

    /** 二选一的行（v5 的 onUnknown 用）：两个按钮，选中的那个高亮。 */
    function ChoiceRow({ title, help, value, options, onChange }) {
      return h(
        'div',
        { className: 'qg-row' },
        h(
          'div',
          { className: 'qg-row-main' },
          h('div', { className: 'qg-row-title' }, title),
          help ? h('div', { className: 'qg-row-help' }, help) : null,
        ),
        h(
          'div',
          { className: 'qg-choice' },
          options.map((option) =>
            h(
              'button',
              {
                key: option.value,
                type: 'button',
                className: `qg-choice-btn${value === option.value ? ' on' : ''}`,
                onClick: () => onChange(option.value),
              },
              option.label,
            ),
          ),
        ),
      )
    }

    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '-'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * 这一条判的是「哪个对话」。宿主侧已经把 `sessionTitle` / `sessionId` 补在每一行上了
     * （`lib/index.js` 的 `withTitles`），拿不到标题就退回短号——
     * 光给一串 `session-xxxxxxxx-…` 认不出是哪个对话，光给标题又不好对照日志。
     */
    function sessionCell(entry) {
      const id = typeof entry.sessionId === 'string' && entry.sessionId !== '' ? entry.sessionId : ''
      const title = typeof entry.sessionTitle === 'string' ? entry.sessionTitle.trim() : ''
      if (id === '' && title === '') return h('span', { className: 'qg-muted' }, '-')
      const label = title !== '' ? title : id.slice(0, 8)
      return h(
        'div',
        { className: 'qg-session', title: id === '' ? title : `session-${id}` },
        h('span', { className: 'qg-session-title' }, label),
        id !== '' && title !== '' ? h('span', { className: 'qg-session-id' }, id.slice(0, 8)) : null,
      )
    }

    function auditRow(entry, index) {
      let tag = ['idle', '没判']
      if (entry.error !== undefined) tag = ['fail', '出错放行']
      else if (entry.failed === true) tag = ['fail', entry.dryRun === true ? '不过·只记录' : '不过·打回']
      else if (entry.failed === false) tag = ['pass', '通过']
      return h(
        'tr',
        { key: `${entry.at ?? index}-${index}` },
        h('td', { className: 'num' }, formatTime(entry.at)),
        h('td', null, sessionCell(entry)),
        /** 这一列是「**这一轮对话里判官第几次出现**」（1、2、3 这种小数字，对应被打回几次）。 */
        h(
          'td',
          { className: 'num', title: entry.turn === undefined ? undefined : `对话第 ${entry.turn} 轮` },
          entry.judgeNth === undefined || entry.judgeNth === null
            ? entry.turn === undefined || entry.turn === null ? '-' : String(entry.turn)
            : String(entry.judgeNth),
        ),
        h('td', { className: 'num' }, entry.score === undefined ? '-' : String(entry.score)),
        h('td', null, h('span', { className: `qg-tag ${tag[0]}` }, tag[1])),
        h('td', null, entry.error !== undefined ? String(entry.error) : entry.worst || '-'),
      )
    }

    function EngineBanner({ engines }) {
      if (!engines) return null
      if (engines.conflict) {
        return h(
          'div',
          { className: 'qg-banner is-bad' },
          h('span', { className: 'qg-dot bad' }),
          h(
            'div',
            null,
            h('b', null, '两套引擎同时在跑：'),
            'fork 版 quality-review 和自研 selfcheck-guard 都挂着，会互相打回、双倍花钱。去 插件 页关掉一个。',
          ),
        )
      }
      if (engines.selfcheck && engines.selfcheck.mounted) {
        return h(
          'div',
          { className: 'qg-banner is-ok' },
          h('span', { className: 'qg-dot ok' }),
          h(
            'div',
            null,
            h('b', null, '自研引擎 selfcheck-guard 在跑：'),
            '本页的改动写进 settings.json，引擎下一轮就按新的判——不用重载、不用重启。',
          ),
        )
      }
      if (engines.fork && engines.fork.mounted && engines.fork.enabled) {
        return h(
          'div',
          { className: 'qg-banner is-warn' },
          h('span', { className: 'qg-dot warn' }),
          h(
            'div',
            null,
            h('b', null, '现在跑的是 fork 版 quality-review：'),
            '它的判据在它自己的 sop 目录、触发项在 cordis.patch.yml 里，本页存的设置它还读不到。',
            h('div', { className: 'qg-row-help' }, '要本页真正管用，得先让它换到 selfcheck-guard（这一步要改挂载，见交付说明）。'),
          ),
        )
      }
      return h(
        'div',
        { className: 'qg-banner is-idle' },
        h('span', { className: 'qg-dot' }),
        h('div', null, h('b', null, '没有任何质检引擎在跑：'), '本页只保存设置，不会有任何东西被检查。'),
      )
    }

    function QualityPanel() {
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [status, setStatus] = React.useState({ kind: 'loading', text: '读取中…' })
      const [error, setError] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      /** v1.4.0：宿主给的模型目录。null ＝还在读；读到了但 available=false ＝退回手填。 */
      const [catalog, setCatalog] = React.useState(null)
      /** 当前选中的那个模型自己报出来的思考档位；空数组＝没报、或还没问出来。 */
      const [efforts, setEfforts] = React.useState([])

      const load = React.useCallback(async () => {
        setStatus({ kind: 'loading', text: '读取中…' })
        setError('')
        try {
          const body = await api.state()
          setState(body)
          setDraft(toDraft(body.settings))
          setStatus({ kind: 'ok', text: body.degraded ? '磁盘上的设置读不懂，已按默认值显示' : '已读取磁盘上的当前设置' })
        } catch (cause) {
          setStatus({ kind: 'bad', text: '读不到设置' })
          setError(String((cause && cause.message) || cause))
        }
        // 模型目录单独走：它挂了也不能影响设置本身显示，所以放在 try 外面、自己兜底。
        try {
          const body = await api.models()
          const list = body && Array.isArray(body.providers) ? body.providers : []
          setCatalog({ available: body && body.available === true, providers: list })
        } catch {
          setCatalog({ available: false, providers: [] })
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const patchDraft = React.useCallback((mutate) => {
        setDraft((current) => {
          if (current === null) return current
          const next = {
            ...current,
            triggers: { ...current.triggers },
            judge: { ...current.judge },
            criteria: current.criteria.map((item) => ({ ...item })),
          }
          mutate(next)
          return next
        })
        setStatus((current) => (current.kind === 'ok' ? { kind: 'dirty', text: '有改动还没保存' } : current))
      }, [])

      const save = React.useCallback(async () => {
        if (draft === null) return
        setSaving(true)
        setError('')
        try {
          const payload = fromDraft(draft)
          const body = await api.save(payload)
          setState((current) => ({ ...(current || {}), ...body }))
          setDraft(toDraft(body.settings))
          setStatus({
            kind: 'ok',
            text: `已保存并生效 · ${formatTime(body.settings.updatedAt)}`,
          })
          setTimeout(() => {
            api.state().then((fresh) => setState(fresh)).catch(() => {})
          }, 400)
        } catch (cause) {
          setStatus({ kind: 'bad', text: '没保存' })
          setError(String((cause && cause.message) || cause))
        } finally {
          setSaving(false)
        }
      }, [draft])

      const resetToDefaults = React.useCallback(async () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('恢复出厂判据和触发项？当前设置会先备份成 settings.json.bak。')) return
        }
        setSaving(true)
        setError('')
        try {
          const body = await api.reset()
          setState((current) => ({ ...(current || {}), ...body }))
          setDraft(toDraft(body.settings))
          setStatus({ kind: 'ok', text: '已恢复出厂设置并生效' })
        } catch (cause) {
          setStatus({ kind: 'bad', text: '恢复失败' })
          setError(String((cause && cause.message) || cause))
        } finally {
          setSaving(false)
        }
      }, [])

      const selectedProvider =
        draft === null || draft.judge.model === null || draft.judge.model === undefined ? '' : draft.judge.model.provider
      const selectedModel =
        draft === null || draft.judge.model === null || draft.judge.model === undefined ? '' : draft.judge.model.model

      // 选中 provider+model 之后问一次「这个模型自己报了哪些档位」，供档位下拉收窄用。
      React.useEffect(() => {
        if (selectedProvider === '' || selectedModel === '') {
          setEfforts([])
          return undefined
        }
        let alive = true
        api
          .modelInfo(selectedProvider, selectedModel)
          .then((body) => {
            if (!alive) return
            const list = body && Array.isArray(body.efforts) ? body.efforts : []
            setEfforts(list.filter((effort) => effort && typeof effort.id === 'string' && effort.id !== ''))
          })
          .catch(() => {
            if (alive) setEfforts([])
          })
        return () => {
          alive = false
        }
      }, [selectedProvider, selectedModel])

      if (draft === null) {
        return h(
          'div',
          { className: 'qg-root' },
          h(
            'div',
            { className: 'qg-wrap' },
            h('div', { className: 'qg-banner is-idle' }, h('span', { className: 'qg-dot' }), h('div', null, status.text)),
            error === '' ? null : h('div', { className: 'qg-err' }, error),
          ),
        )
      }

      const engines = state && state.engines
      const audit = (state && state.audit) || []
      const files = (state && state.files) || null

      // 模型下拉的数据面：宿主没给 llm 服务（或整包读失败）就退回手填，绝不让面板炸掉。
      const providerList = catalog && Array.isArray(catalog.providers) ? catalog.providers : []
      const manualModel = catalog !== null && (catalog.available !== true || providerList.length === 0)
      const providerModels =
        (providerList.find((provider) => provider.id === selectedProvider) || { models: [] }).models || []
      const providerOptions = [{ value: '', label: '跟当前会话同一条线' }].concat(
        providerList.map((provider) => ({ value: provider.id, label: provider.name || provider.id })),
      )
      const modelOptions = [{ value: '', label: selectedProvider === '' ? '先选上面那条线' : '选一个模型' }].concat(
        providerModels.map((model) => ({ value: model.id, label: model.name || model.id })),
      )
      // 手填/旧配置里的 provider、model 可能不在宿主报的清单里 —— 补一格，不然下拉会显示成空。
      if (selectedProvider !== '' && !providerOptions.some((option) => option.value === selectedProvider)) {
        providerOptions.push({ value: selectedProvider, label: `${selectedProvider}（当前设置，宿主没报这条线）` })
      }
      if (selectedModel !== '' && !modelOptions.some((option) => option.value === selectedModel)) {
        modelOptions.push({ value: selectedModel, label: `${selectedModel}（当前设置，宿主没报这个型号）` })
      }
      const effortChoices =
        efforts.length === 0 ? EFFORT_OPTIONS : effortOptions(efforts, draft.reasoningEffort)

      return h(
        'div',
        { className: 'qg-root', 'data-dsh-quality-guard': '' },
        h(
          'div',
          { className: 'qg-wrap' },
          h(
            'div',
            { className: 'qg-head' },
            h(
              'div',
              null,
              h('h1', null, '质检'),
              h('p', null, '发消息之前，先让另一个模型拿你定的尺子读一遍；这一页就是那把尺子。'),
            ),
            h(
              'div',
              { className: 'qg-head-actions' },
              h('button', { type: 'button', className: 'qg-btn', onClick: load, disabled: saving }, '刷新'),
              h('button', { type: 'button', className: 'qg-btn danger', onClick: resetToDefaults, disabled: saving }, '恢复默认'),
            ),
          ),
          h(EngineBanner, { engines }),

          // ── 触发 ──
          h(
            'section',
            { className: 'qg-section' },
            h('header', null, h('h2', null, '什么时候查'), h('span', null, '触发条件')),
            h(ToggleRow, {
              title: '启用质检',
              help: HELP.enabled,
              checked: draft.enabled,
              onChange: (value) => patchDraft((next) => { next.enabled = value }),
            }),
            h(ToggleRow, {
              title: '演习模式（只记录，不打回）',
              help: HELP.dryRun,
              checked: draft.dryRun,
              onChange: (value) => patchDraft((next) => { next.dryRun = value }),
            }),
            h(NumberRow, {
              title: '回复至少这么长才查',
              help: HELP.minReplyChars,
              value: draft.triggers.minReplyChars,
              min: 0,
              max: 20000,
              unit: '字',
              onChange: (value) => patchDraft((next) => { next.triggers.minReplyChars = value }),
            }),
            h(NumberRow, {
              title: '最多打回几次',
              help: HELP.maxReworks,
              value: draft.triggers.maxReworks,
              min: 0,
              max: 10,
              unit: '次',
              onChange: (value) => patchDraft((next) => { next.triggers.maxReworks = value }),
            }),
            h(NumberRow, {
              title: '及格线',
              help: HELP.scoreThreshold,
              value: draft.triggers.scoreThreshold,
              min: 0,
              max: 100,
              unit: '分',
              onChange: (value) => patchDraft((next) => { next.triggers.scoreThreshold = value }),
            }),
          ),

          // ── 要求 ──
          h(
            'section',
            { className: 'qg-section' },
            h('header', null, h('h2', null, '按什么查'), h('span', null, '判据 · 判官只看这里的字')),
            draft.criteria.map((item, index) =>
              h(
                'div',
                { key: item.id || index, className: `qg-card${item.enabled === false ? ' is-off' : ''}` },
                h(
                  'div',
                  { className: 'qg-card-head' },
                  h(Switch, {
                    checked: item.enabled !== false,
                    onChange: (value) => patchDraft((next) => { next.criteria[index].enabled = value }),
                  }),
                  h('span', { className: 'qg-card-no' }, String(index + 1)),
                  h('input', {
                    className: 'qg-label-input',
                    value: item.label || '',
                    placeholder: '这条叫什么（短标题，只给你看）',
                    onChange: (event) => patchDraft((next) => { next.criteria[index].label = event.target.value }),
                  }),
                  draft.criteria.length <= 1
                    ? null
                    : h(
                        'button',
                        {
                          type: 'button',
                          className: 'qg-btn tiny danger',
                          onClick: () => patchDraft((next) => { next.criteria.splice(index, 1) }),
                        },
                        '删除',
                      ),
                ),
                h('textarea', {
                  className: 'qg-text',
                  value: item.text,
                  rows: 2,
                  placeholder: '判官要照这个判，写成一句可执行的话',
                  onChange: (event) => patchDraft((next) => { next.criteria[index].text = event.target.value }),
                }),
              ),
            ),
            h(
              'div',
              { className: 'qg-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'qg-btn',
                  onClick: () =>
                    patchDraft((next) => {
                      next.criteria.push({ id: `c${Date.now()}`, label: '', enabled: true, text: '' })
                    }),
                },
                '+ 加一条判据',
              ),
            ),
          ),

          // ── 例外 ──
          h(
            'section',
            { className: 'qg-section' },
            h('header', null, h('h2', null, '什么情况不算违规'), h('span', null, '例外 · 一行一条')),
            h('textarea', {
              className: 'qg-text',
              value: draft.exceptions,
              rows: 3,
              placeholder: '例：这一轮明确要了「详细说 / 完整版」→ 长和细都不算违规',
              onChange: (event) => patchDraft((next) => { next.exceptions = event.target.value }),
            }),
          ),

          // ── 判官提示词（v1.7.0：跟判据一样随便改，改完下一轮生效） ──
          h(
            'section',
            { className: 'qg-section' },
            h('header', null, h('h2', null, '判官提示词'), h('span', null, '决定判官松紧 · 跟判据一样随便改')),
            h('div', { className: 'qg-row-help', style: { marginBottom: '6px' } }, '① ' + HELP.judgeSystem),
            h('textarea', {
              className: 'qg-text',
              value: draft.judgeSystem,
              rows: 5,
              onChange: (event) => patchDraft((next) => { next.judgeSystem = event.target.value }),
            }),
            h('div', { className: 'qg-row-help', style: { margin: '14px 0 6px' } }, '② ' + HELP.judgeRules),
            h('textarea', {
              className: 'qg-text',
              value: draft.judgeRules,
              rows: 12,
              onChange: (event) => patchDraft((next) => { next.judgeRules = event.target.value }),
            }),
          ),

          // ── 判官细节 ──
          h(
            'section',
            { className: 'qg-section' },
            h('header', null, h('h2', null, '判官这台机器'), h('span', null, '一般不用动')),
            // v1.4.0：超时已停用（引擎里那段 setTimeout 删了），这里只留一行说明。
            h(
              'div',
              { className: 'qg-row' },
              h(
                'div',
                { className: 'qg-row-main' },
                h('div', { className: 'qg-row-title' }, '超时'),
                h('div', { className: 'qg-row-help' }, HELP.timeoutMs),
              ),
              h('span', { className: 'qg-unit', style: { width: 'auto' } }, '已停用'),
            ),
            // v1.4.0：档位改由人挑；默认那一档＝一个字节都不发。
            h(
              'div',
              { className: 'qg-row' },
              h(
                'div',
                { className: 'qg-row-main' },
                h('div', { className: 'qg-row-title' }, '思考档位'),
                h('div', { className: 'qg-row-help' }, HELP.judgeAuto),
                efforts.length === 0
                  ? null
                  : h(
                      'div',
                      { className: 'qg-row-help' },
                      `这个模型自己报的支持：${efforts.map((effort) => effort.name || effort.id).join(' / ')}`,
                    ),
              ),
              h(
                'select',
                {
                  className: 'qg-select',
                  value: draft.reasoningEffort,
                  onChange: (event) => patchDraft((next) => { next.reasoningEffort = event.target.value }),
                },
                effortChoices.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
              ),
            ),
            h(ChoiceRow, {
              title: '判官拿不到裁定时',
              help: HELP.onUnknown,
              value: draft.onUnknown,
              options: [
                { value: 'pass', label: '放行' },
                { value: 'rework', label: '打回重写' },
              ],
              onChange: (value) => patchDraft((next) => { next.onUnknown = value }),
            }),
            h(
              'div',
              { className: 'qg-row' },
              h(
                'div',
                { className: 'qg-row-main' },
                h('div', { className: 'qg-row-title' }, '判官模型'),
                h('div', { className: 'qg-row-help' }, HELP.judgeModel),
                manualModel ? h('div', { className: 'qg-row-help' }, '宿主没给模型列表，只能手填。') : null,
              ),
              manualModel
                ? h(
                    'div',
                    { className: 'qg-choice' },
                    h('input', {
                      className: 'qg-num',
                      style: { width: '150px', textAlign: 'left' },
                      placeholder: 'provider',
                      value: selectedProvider,
                      onChange: (event) =>
                        patchDraft((next) => {
                          const provider = event.target.value
                          const model = next.judge.model ? next.judge.model.model : ''
                          next.judge.model = provider === '' && model === '' ? null : { provider, model }
                        }),
                    }),
                    h('input', {
                      className: 'qg-num',
                      style: { width: '150px', textAlign: 'left' },
                      placeholder: 'model',
                      value: selectedModel,
                      onChange: (event) =>
                        patchDraft((next) => {
                          const model = event.target.value
                          const provider = next.judge.model ? next.judge.model.provider : ''
                          next.judge.model = provider === '' && model === '' ? null : { provider, model }
                        }),
                    }),
                  )
                : h(
                    'div',
                    { className: 'qg-choice' },
                    h(
                      'select',
                      {
                        className: 'qg-select',
                        style: { width: '170px' },
                        value: selectedProvider,
                        onChange: (event) => {
                          const provider = event.target.value
                          patchDraft((next) => {
                            // 换 provider 就把 model 清空，免得留下一个对面根本没有的型号。
                            next.judge.model = provider === '' ? null : { provider, model: '' }
                          })
                        },
                      },
                      providerOptions.map((option) =>
                        h('option', { key: option.value, value: option.value }, option.label),
                      ),
                    ),
                    h(
                      'select',
                      {
                        className: 'qg-select',
                        style: { width: '170px' },
                        value: selectedModel,
                        disabled: selectedProvider === '',
                        onChange: (event) => {
                          const model = event.target.value
                          patchDraft((next) => {
                            if (model === '') {
                              next.judge.model = null
                              return
                            }
                            next.judge.model = { provider: selectedProvider, model }
                          })
                        },
                      },
                      modelOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
                    ),
                  ),
            ),
          ),

          // ── 记录 ──
          h(
            'section',
            { className: 'qg-section' },
            h(
              'header',
              null,
              h('h2', null, '最近判了什么'),
              h('span', null, '只留最后 20 条 · 用来校准这套尺子'),
            ),
            audit.length === 0
              ? h('div', { className: 'qg-empty' }, '还没有判决记录。等一条回复结束、判官看过之后就会出现在这里。')
              : h(
                  'table',
                  { className: 'qg-audit' },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      h('th', null, '时间'),
                      h('th', null, '对话'),
                      h('th', null, '判官第几次'),
                      h('th', null, '分'),
                      h('th', null, '结果'),
                      h('th', null, '最严重的那条'),
                    ),
                  ),
                  h('tbody', null, audit.slice().reverse().map(auditRow)),
                ),
          ),

          // ── 文件 ──
          files === null
            ? null
            : h(
                'section',
                { className: 'qg-section' },
                h('header', null, h('h2', null, '落在哪'), h('span', null, '手动改也行，引擎下一轮就按新的判')),
                h(
                  'div',
                  { className: 'qg-row' },
                  h(
                    'div',
                    { className: 'qg-row-main' },
                    h('div', { className: 'qg-row-title' }, '设置'),
                    h('div', { className: 'qg-meta' }, files.settings.path),
                  ),
                  h('span', { className: 'qg-row-help' }, files.settings.exists ? `${files.settings.size} B` : '还没建'),
                ),
                h(
                  'div',
                  { className: 'qg-row' },
                  h(
                    'div',
                    { className: 'qg-row-main' },
                    h('div', { className: 'qg-row-title' }, '判决日志'),
                    h('div', { className: 'qg-meta' }, files.audit.path),
                  ),
                  h('span', { className: 'qg-row-help' }, files.audit.exists ? `${files.audit.size} B` : '还没写'),
                ),
              ),

          // ── 保存条 ──
          h(
            'div',
            { className: 'qg-foot' },
            h('span', { className: `qg-state ${status.kind}`, 'data-qg-status': status.kind }, status.text),
            h('span', { className: 'qg-spacer' }),
            error === '' ? null : h('span', { className: 'qg-err', style: { marginTop: 0 } }, error),
            h(
              'button',
              {
                type: 'button',
                className: 'qg-btn',
                onClick: () => {
                  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
                    if (!window.confirm('用上一次保存前的备份覆盖当前设置？')) return
                  }
                  api
                    .restore()
                    .then((body) => {
                      setState((current) => ({ ...(current || {}), ...body }))
                      setDraft(toDraft(body.settings))
                      setStatus({ kind: 'ok', text: '已用备份覆盖并生效' })
                    })
                    .catch((cause) => {
                      setStatus({ kind: 'bad', text: '回退失败' })
                      setError(String((cause && cause.message) || cause))
                    })
                },
                disabled: saving,
              },
              '用上次备份',
            ),
            h(
              'button',
              { type: 'button', className: 'qg-btn primary', onClick: save, disabled: saving, 'data-qg-save': '' },
              saving ? '保存中…' : '保存并生效',
            ),
          ),
        ),
      )
    }

    module.exports.inject = ['slots', 'layout']
    module.exports.apply = (ctx) => {
      if (h === null) return
      if (!ctx || !ctx.slots) return
      try {
        if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
          const tag = document.createElement('style')
          tag.setAttribute('data-plugin', NS)
          tag.setAttribute('data-plugin-css', CSS_ID)
          tag.textContent = CSS
          document.head.append(tag)
        }
      } catch {
        // 样式挂了也要让功能挂上去。
      }

      const disposers = []
      const mount = (slotName, register) => {
        const dispose = ctx.slots.inject(slotName, register)
        if (typeof dispose === 'function') disposers.push(dispose)
      }

      ctx.effect(() => {
        mount('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: PANEL_ORDER,
              label: () => '质检',
            },
            PanelIcon,
          ),
        )
        mount('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, QualityPanel),
        )
        return () => {
          for (const dispose of disposers.splice(0)) dispose()
        }
      }, 'quality-guard: panel')
    }

    return module.exports
  },
})
