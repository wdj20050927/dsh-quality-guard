#!/usr/bin/env node
// 发版一致性检查：三份 manifest / README / CHANGELOG / npm / GitHub Release / 目录站 tarball
// 用法：node scripts/check-versions.mjs            只查本地
//       node scripts/check-versions.mjs --remote   连 npm、GitHub、目录站一起查
// 退出码：0 全一致；1 有不一致（逐条列出）

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'wdj20050927/dsh-quality-guard';
const DIR_SITE = 'awesome-dsh-plugin/awesome-dsh-plugin';
const DIR_FILE = 'data/plugins/wdj20050927__dsh-quality-guard.yml';

const rows = [];
const add = (where, ok, detail) => rows.push({ where, ok, detail });
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

// 1. 三份 manifest 必须同版本
const manifests = ['package.json', 'panel/package.json', 'engine/package.json'];
const versions = manifests.map((p) => json(p).version);
const same = versions.every((v) => v === versions[0]);
add('三份 manifest', same, manifests.map((p, i) => `${p}=${versions[i]}`).join('  '));
const V = versions[0];

// 2. BOM 检查（带 BOM 会让 dsh 拒绝加载 profile bundle）
const boms = manifests.filter((p) => readFileSync(join(ROOT, p))[0] === 0xef);
add('manifest 无 BOM', boms.length === 0, boms.length ? `带 BOM：${boms.join(', ')}` : '三份首字节均非 ef bb bf');

// 3. README / CHANGELOG 的版本字样
for (const p of ['README.md', 'CHANGELOG.md']) {
  const hits = [...read(p).matchAll(new RegExp(V.replace(/\./g, '\\.') + '(?![0-9])', 'g'))].length;
  add(`${p} 提到 ${V}`, hits > 0, `${hits} 处`);
}

// 4. README 里残留的旧 tag 直链（最容易忘）
// CHANGELOG 不查：它按版本分段记历史，旧段保留旧 tag 才是对的。
const stale = [...read('README.md').matchAll(/\/download\/v(\d+\.\d+\.\d+)\//g)]
  .filter((m) => m[1] !== V)
  .map((m) => `README.md 指向 v${m[1]}`);
add('README 无旧 tag 直链', stale.length === 0, stale.length ? stale.join('; ') : '全部指向当前版本');

if (!process.argv.includes('--remote')) {
  report();
}

async function get(url, asJson = true) {
  const r = await fetch(url, { headers: { 'user-agent': 'check-versions' } });
  if (!r.ok) throw new Error(`http=${r.status} ${url}`);
  return asJson ? r.json() : r.text();
}

// 5. npm latest
try {
  const npm = await get('https://registry.npmjs.org/dsh-quality-guard/latest');
  add('npm latest', npm.version === V, `registry=${npm.version}`);
} catch (e) {
  add('npm latest', false, e.message);
}

// 6. GitHub Release 资产
try {
  const rel = await get(`https://api.github.com/repos/${REPO}/releases/tags/v${V}`);
  const asset = (rel.assets || []).find((a) => a.name.endsWith('.tgz'));
  add(`Release v${V}`, Boolean(asset), asset ? `${asset.name} size=${asset.size}` : '没有 tgz 资产');
} catch (e) {
  add(`Release v${V}`, false, e.message);
}

// 7. 目录站 tarball 指向的 tag
try {
  const yml = await get(`https://raw.githubusercontent.com/${DIR_SITE}/main/${DIR_FILE}`, false);
  const m = yml.match(/tarball:\s*(\S+)/);
  const tag = m ? (m[1].match(/\/download\/v(\d+\.\d+\.\d+)\//) || [])[1] : null;
  add('目录站 tarball', tag === V, m ? `tarball tag=v${tag}` : '条目里没有 tarball 字段');
} catch (e) {
  add('目录站 tarball', false, e.message);
}

report();

function report() {
  const pad = Math.max(...rows.map((r) => r.where.length));
  for (const r of rows) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.where.padEnd(pad)}  ${r.detail}`);
  }
  const bad = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - bad.length}/${rows.length} 一致 · 当前版本 ${V}`);
  if (bad.length) {
    console.log(`不一致 ${bad.length} 处：${bad.map((r) => r.where).join(', ')}`);
    process.exit(1);
  }
}
