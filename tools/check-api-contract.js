/**
 * tools/check-api-contract.js
 *
 * 静态核对前端 call() 与云函数 handler 的字段契约。
 *
 * 为什么需要它：
 *   request.js 的签名是 call(云函数名, 分发动作, 业务参数)。
 *   分发动作会被合并进 event.action，云函数用 switch (event.action) 分发。
 *   如果某个 handler 又把 event.action 当业务参数读，或者前端把业务参数命名成
 *   action，就会出现「请求落不到目标分支」或「参数静默丢失」，
 *   而且不报错、不抛异常 —— 极难排查（下架/取消订单就踩过这个坑）。
 *
 * 本脚本能发现三类问题：
 *   1. 前端传了字段，但 handler 从来没读过（死参数，典型是 action 撞车）
 *   2. handler 读取的必填字段，前端没传
 *   3. 前端 call 的动作名，云函数里没有对应 case
 *
 * 用法：node tools/check-api-contract.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CF_DIR = path.join(ROOT, 'cloudfunctions');
const MP_DIR = path.join(ROOT, 'miniprogram');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 去掉注释，否则注释里的文字会被当成字段名解析掉 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
}

/** 取出 `{ a, b = 1, c }` 里的字段名，并记录是否有默认值 */
function objectKeys(src) {
  const keys = new Map();
  const depth0 = stripComments(src).replace(/\{[^{}]*\}/g, '');
  for (const part of depth0.split(',')) {
    const m = part.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::\s*|=\s*([^,]*)|$)/);
    if (m) keys.set(m[1], m[2] !== undefined && m[2].trim() !== '');
  }
  return keys;
}

/** 从 `{` 开始按配对取函数体，避免把下一个函数的代码算进来 */
function sliceBody(src, openBraceIdx) {
  let depth = 0;
  for (let i = openBraceIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(openBraceIdx + 1, i);
    }
  }
  return src.slice(openBraceIdx + 1);
}

/* ---------- 1. 云函数：action → handler，以及 handler 读取了哪些字段 ---------- */

const cloud = {}; // { 云函数名: { cases: Set, handlers: { name: {keys, line} } } }

for (const dir of fs.readdirSync(CF_DIR)) {
  const file = path.join(CF_DIR, dir, 'index.js');
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');

  const cases = new Set();
  const caseRe = /case\s+'([^']+)'\s*:\s*return\s+(?:await\s+)?(\w+)\s*\(/g;
  const handlerOf = {};
  let m;
  while ((m = caseRe.exec(src))) {
    cases.add(m[1]);
    handlerOf[m[1]] = m[2];
  }

  const handlers = {};
  const fnRe = /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g;
  while ((m = fnRe.exec(src))) {
    const name = m[1];
    const bodyStart = m.index + m[0].length;
    const body = sliceBody(src, bodyStart - 1);
    const d = body.match(/const\s*\{([^}]*)\}\s*=\s*event/);
    if (!d) {
      handlers[name] = null;
      continue;
    }
    // `if (!a || !b) throw E.PARAM` 里的字段才算必填
    const required = new Set();
    for (const g of body.match(/!\s*([A-Za-z_$][\w$]*)/g) || []) {
      required.add(g.replace(/!\s*/, ''));
    }
    handlers[name] = { keys: objectKeys(d[1]), required };
  }

  cloud[dir] = { cases, handlerOf, handlers };
}

/* ---------- 2. 前端：所有 call() 调用 ---------- */

const calls = [];
for (const file of walk(MP_DIR)) {
  const src = fs.readFileSync(file, 'utf8');
  // call('name', 'action', { ... }) —— payload 可能跨行
  const re = /call\(\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*(\{)?/g;
  let m;
  while ((m = re.exec(src))) {
    const [, cf, action, brace] = m;
    let keys = new Map();
    if (brace) {
      // 向后扫描配对的 }
      let i = re.lastIndex - 1;
      let depth = 0;
      let end = i;
      for (; end < src.length; end++) {
        if (src[end] === '{') depth++;
        else if (src[end] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      keys = objectKeys(src.slice(i + 1, end));
    }
    const line = src.slice(0, m.index).split('\n').length;
    calls.push({ file: path.relative(ROOT, file), line, cf, action, keys });
  }
}

/* ---------- 3. 比对 ---------- */

const problems = [];
const IGNORE = new Set(['undefined']);

for (const c of calls) {
  const mod = cloud[c.cf];
  if (!mod) {
    problems.push(`[云函数不存在] ${c.file}:${c.line} 调用了 ${c.cf}`);
    continue;
  }
  if (!mod.cases.has(c.action)) {
    problems.push(`[无此动作]     ${c.file}:${c.line} ${c.cf}/${c.action} —— 云函数里没有这个 case`);
    continue;
  }

  const handlerName = mod.handlerOf[c.action];
  const read = mod.handlers[handlerName];
  if (!read) continue;

  // 前端传了但 handler 不读 → 死参数，最危险
  for (const k of c.keys.keys()) {
    if (IGNORE.has(k)) continue;
    if (!read.keys.has(k)) {
      problems.push(
        `[死参数]       ${c.file}:${c.line} ${c.cf}/${c.action} 传了 "${k}"，但 ${handlerName}() 没读它` +
          (k === 'action' ? '  ← action 是分发键，业务参数请用 op' : '')
      );
    }
  }

  // handler 有 `if (!x)` 校验、前端却没传 → 真缺参数
  for (const k of read.required) {
    if (!read.keys.has(k)) continue;
    if (!c.keys.has(k)) {
      problems.push(`[缺必填参数]   ${c.file}:${c.line} ${c.cf}/${c.action} 没传 "${k}"，${handlerName}() 会校验它`);
    }
  }
}

/* ---------- 输出 ---------- */

console.log(`扫描到 ${calls.length} 处 call() 调用，覆盖 ${Object.keys(cloud).length} 个云函数\n`);

if (problems.length === 0) {
  console.log('接口契约一致，没有发现问题。');
  process.exit(0);
}

console.log(`发现 ${problems.length} 处问题：\n`);
for (const p of problems) console.log('  ' + p);
process.exit(1);
