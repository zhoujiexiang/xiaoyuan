/**
 * tools/e2e-test.cjs — 小程序端到端冒烟测试（真实模拟器 + 真实云函数）
 *
 * 前置：微信开发者工具已打开本项目，且自动化端口可用：
 *   1) cli.bat close  --project <项目路径>
 *   2) cli.bat auto   --project <项目路径> --auto-port 9700
 *   注意：端口必须避开 Windows 保留段（netsh int ipv4 show excludedportrange protocol=tcp）
 *
 * 运行：
 *   NODE_PATH=<node_modules 目录> node tools/e2e-test.cjs [ws端口]
 *   默认 ws://127.0.0.1:9700
 *
 * 覆盖：环境/登录态 → 全部页面渲染 → 7 个云函数契约 → 下架/重新上架真实点击
 *       → 头像昵称 + 图片内容安全真实链路 → 分享 → 订单/消息/举报守卫 → 管理端只读接口
 *       → 退出登录 → 用户主页/头像私聊 → 校园跑腿（发布/接单/取消/列表隔离）
 * 测试数据会自动清理（含云存储文件、头像昵称还原）。
 */
const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

const CONFIG = require(path.resolve(__dirname, '../miniprogram/config.js'));

const WS_PORT = Number(process.argv[2] || 9700);
const WS = `ws://127.0.0.1:${WS_PORT}`;
const SHOT_DIR = path.resolve(__dirname, '../.workbuddy/e2e-shots');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 注入 + 轮询调用云函数（mini.evaluate 对 Promise 支持不稳定） */
async function callFn(mini, name, data) {
  await mini.evaluate(
    (fnName, payload) => {
      globalThis.__R = { done: false };
      wx.cloud
        .callFunction({ name: fnName, data: payload })
        .then(r => {
          globalThis.__R = { done: true, ok: true, result: r.result };
        })
        .catch(e => {
          globalThis.__R = { done: true, ok: false, err: (e && (e.errMsg || e.message)) || String(e) };
        });
    },
    name,
    data
  );
  for (let i = 0; i < 60; i++) {
    const r = await mini.evaluate(() => globalThis.__R);
    if (r && r.done) return r;
    await sleep(400);
  }
  return { done: false, ok: false, err: '轮询超时' };
}

const brief = r => {
  if (!r.ok) return '❌ ' + r.err;
  const d = r.result || {};
  if (d.code !== 0) return `❌ ${d.code} ${d.msg}`;
  return '✅ ' + JSON.stringify(d.data).slice(0, 160);
};

const codeOf = r => (r.ok && r.result ? r.result.code : -1);
const dataOf = r => (r.ok && r.result && r.result.code === 0 ? r.result.data : null);

/**
 * 读取当前页面状态。
 * 不走 mini.currentPage()（reLaunch 后 IDE 侧偶发
 * "Cannot destructure property 'rawPath' of getPageMetaByWebviewId(...)"），
 * 直接在逻辑层取页面栈最后一页，稳定得多。
 */
async function evalPage(mini) {
  return mini.evaluate(() => {
    const ps = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    if (!ps.length) return null;
    const p = ps[ps.length - 1];
    let data = {};
    try { data = JSON.parse(JSON.stringify(p.data || {})); } catch (e) { data = {}; }
    return { route: p.route, stackDepth: ps.length, data };
  });
}

/** 取页面代理用于真实点击；IDE 侧偶尔取不到，重试几次 */
/**
 * 取当前页面实例。
 *
 * 坑（真实踩过）：`reLaunch` 刚结束时 `mini.currentPage()` 会**连续抛错或返回 null**
 *   Cannot destructure property 'rawPath' of getPageMetaByWebviewId(...)
 * 实测曾导致一次「首页可转发」假失败 —— 页面实例没取到，脚本连 callMethod 都没执行，
 * 断言却记成「功能坏了」。所以这里重试要够久（10 次 × 800ms ≈ 8s），
 * 让上层调用点拿到实例是常态、拿不到才真报警。
 */
async function getPage(mini, tries = 10) {
  for (let i = 0; i < tries; i++) {
    try {
      const p = await mini.currentPage();
      if (p) return p;
    } catch (e) { /* 重试 */ }
    await sleep(800);
  }
  return null;
}

async function screenshot(mini, name) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    // 先等一帧再拍。实测刚 reLaunch 完立刻 screenshot 会抓到「上一页」的画面
    // （自动化客户端缓存的 currentPage 还没切换），导致截图与它声称的步骤对不上。
    await sleep(800);
    try {
      const pg = await getPage(mini);
      const where = pg && (pg.path || pg.route);
      if (where) console.log(`   （截图 ${name}.png ← 当前页 ${where}）`);
    } catch (e) {}
    const p = path.join(SHOT_DIR, `${name}.png`);
    await mini.screenshot({ path: p });
    return p;
  } catch (e) {
    return null;
  }
}

(async () => {
  let mini;
  const jsErrors = [];
  // 用户真实商品的安全基线：_id → "标题 / 开测时状态"
  const realProducts = {};
  let createdProductId = null;
  let tempVerified = false;
  let testUserId = null;
  let origUser = {};
  let profileTouched = false;
  let avatarFileID = '';
  let savedAvatarFileID = '';
  // 测试开始时间：用来识别「保存后读到的头像到底是测试上传的，还是用户自己传的」
  let testStartTs = 0;
  // 测试商品标题：提前到顶部，「卡片契约」段在列表为空时也要用它补位
  const TEST_TITLE = '[自动化测试] 闲置教材';

  try {
    /* ---------- 0. 连接 ---------- */
    mini = await automator.connect({ wsEndpoint: WS });
    record('连接自动化端口', true, WS);

    mini.on('exception', e => jsErrors.push('[exception] ' + JSON.stringify(e).slice(0, 300)));
    mini.on('console', m => {
      if (!(m && m.type === 'error')) return;
      const text = String(m.args || '');
      // 与 app.js#reportError 的过滤口径一致：wx://not-found 是工具内部伪协议，与源码无关。
      // IDE 崩溃重启后首次编译容易冒出这条，不代表组件真的坏了（后面卡片断言会真验）。
      if (text.indexOf('wx://not-found') !== -1) return;
      jsErrors.push('[console.error] ' + text.slice(0, 300));
    });

    /* ---------- 1. 环境 / 登录态 ---------- */
    const sdk = await mini.evaluate(() => wx.getAppBaseInfo().SDKVersion);
    const envId = await mini.evaluate(() => (getApp().globalData || {}).envId);
    record('读取运行环境', !!sdk && !!envId, `SDK ${sdk} / env ${envId}`);

    const profile = await callFn(mini, 'user', { action: 'getProfile' });
    record('user/getProfile', codeOf(profile) === 0, brief(profile));
    const userInfo = (dataOf(profile) || {}).userInfo || {};
    const verifyStatus = userInfo.verifyStatus;
    testUserId = userInfo._id || null;

    // 安全基线：记下用户**真实商品**（标题不含测试标记）此刻的状态。
    // 收尾时逐条比对——一旦脚本碰了用户的真实数据，立刻 FAIL，
    // 而不是等用户自己发现「我发布的商品怎么变成已下架了」。
    // （真的发生过：旧版脚本拿 myList()[0] 当实验对象，把用户商品留在下架状态。）
    const baseline = await callFn(mini, 'product', { action: 'myList', pageSize: 50 });
    for (const r of ((dataOf(baseline) || {}).list || [])) {
      if (/自动化测试/.test(r.title || '')) continue;
      realProducts[r._id] = r.title + ' / ' + r.status;
    }
    console.log(
      `   安全基线：记录用户真实商品 ${Object.keys(realProducts).length} 条（测试期间不允许被改动）`
    );

    // 学校名以 config.js 为准：走一次真实 login，验证老用户记录会被同步过来。
    // （用户记录里的 schoolId 决定同校过滤，改配置后必须能自愈）
    await callFn(mini, 'user', {
      action: 'login',
      nickName: userInfo.nickName || '',
      avatarUrl: userInfo.avatarUrl || '',
      schoolId: CONFIG.school,
      schoolName: CONFIG.school
    });
    const synced = await callFn(mini, 'user', { action: 'getProfile' });
    const su = (dataOf(synced) || {}).userInfo || {};
    record(
      '学校名已同步为 config 值',
      su.schoolId === CONFIG.school && su.schoolName === CONFIG.school,
      `schoolId=${su.schoolId} / schoolName=${su.schoolName} / config=${CONFIG.school}`
    );

    /* ---------- 2. 页面渲染冒烟 ---------- */
    const appJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../miniprogram/app.json'), 'utf8')
    );
    let pageFail = 0;
    for (const p of appJson.pages) {
      const url = '/' + p;
      try {
        await mini.reLaunch(url);
        await sleep(1400);
        const info = await evalPage(mini);
        if (!info || !info.route) throw new Error('页面栈为空');
        if (info.data.loadError) throw new Error('loadError=' + info.data.loadError);
      } catch (e) {
        pageFail++;
        record(`页面 ${p}`, false, (e && e.message) || String(e));
      }
    }
    record(`${appJson.pages.length} 个页面全部渲染`, pageFail === 0, pageFail ? `${pageFail} 个页面异常` : 'all ok');

    // 源码编码守卫（静态检查，不需要云端）：
    // 本项目历史上出现过「混合编码」损坏 —— Write 工具按 GBK 落盘、Edit 保持原编码、
    // shell heredoc 按 UTF-8，三者混用时多字节字符的**末字节会被替换成 '?'**，
    // 表现为界面出现乱码（曾污染首页的「加载中…」「没有更多了」和几处中文注释），
    // 而编译、运行、接口全都不报错，只有肉眼看界面才能发现。
    // 用脚本钉死：所有源码文件必须是合法 UTF-8。
    const encBad = [];
    (function scanSrc(dir) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          if (name !== 'node_modules' && name !== '.git') scanSrc(full);
          continue;
        }
        if (!/\.(js|wxml|wxss|json)$/.test(name)) continue;
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(full));
        } catch (e) {
          encBad.push(path.relative(path.resolve(__dirname, '..'), full));
        }
      }
    })(path.resolve(__dirname, '../miniprogram'));
    record(
      '源码文件全部为合法 UTF-8（防混合编码乱码）',
      encBad.length === 0,
      encBad.length ? '损坏文件：' + encBad.join(', ') : 'miniprogram/ 下全部正常'
    );

    // WXML 静态守卫：<text> 的内容不能跨行。
    // 微信的 <text> 会把内容里的换行**当成换行符渲染**（不是折叠成空格），
    // 所以「内容写在标签的下一行」会凭空多出一个空行：
    //   · 固定高度的徽章（.tag）里，文字被挤到下半格 —— 看起来「偏下、贴着底边」；
    //   · 普通文本里，上方多出一条空行。
    // 本项目真实踩过：mine 页「已认证」徽章文字偏下（用户反馈，2026-09-18），
    // 同类写法另有 7 处（adminProducts 状态徽章、detail/publish 的安全提示、
    // login 的协议文案、mine 的认证引导卡片）。正确写法：内容与标签写在**同一行**。
    const wrapBad = [];
    (function scanWxml(dir) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          if (name !== 'node_modules' && name !== '.git') scanWxml(full);
          continue;
        }
        // 只扫 <text>，不扫 <textarea>（后者多行属性是正常写法）
        if (!/\.wxml$/.test(name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        const rel = path.relative(path.resolve(__dirname, '..'), full);
        if (/<text(?=[\s>])[^>]*>[ \t]*\r?\n/.test(src)) wrapBad.push(rel + '（内容另起一行）');
        if (/\r?\n[ \t]*<\/text>/.test(src)) wrapBad.push(rel + '（内容换行后收尾）');
      }
    })(path.resolve(__dirname, '../miniprogram'));
    record(
      '<text> 内容未跨行（防多出空行 / 徽章文字被挤偏）',
      wrapBad.length === 0,
      wrapBad.length ? '待修：' + wrapBad.join('；') : 'miniprogram/ 下全部正常'
    );

    // 「面交地点」必须是**自由输入**，不能退回成预设选项（2026-09-18 用户要求）。
    // 背景：原来从 config.js 的 tradePlaces 里挑，但校园地点太多，列表永远不够用
    // （「三食堂后门快递架旁边那棵树」这种描述根本塞不进选项）。
    // 静态钉死两件事：① 该项由 <input> 承接 tradePlace；② 不再引用已删除的预设列表。
    {
      const pubWxml = fs.readFileSync(
        path.resolve(__dirname, '../miniprogram/pages/publish/publish.wxml'), 'utf8'
      );
      const asInput = /data-field="tradePlace"/.test(pubWxml);
      const noPreset = !/tradePlaces/.test(pubWxml);
      record(
        '面交地点为自由输入（不再有预设选项）',
        asInput && noPreset,
        asInput && noPreset
          ? 'publish.wxml 用 input 承接 tradePlace'
          : `input=${asInput} / 无预设引用=${noPreset}（改回选项会让位置描述和真实地点对不上）`
      );
    }

    // 组件样式隔离守卫：自定义组件默认 styleIsolation: isolated，
    // **app.wxss 里的 class 选择器对组件内部不生效**（只有标签名选择器能穿透）。
    // 真实踩过（2026-09-18）：product-card 的标题/地点/价格一直在引用全局的
    // .ellipsis / .ellipsis-2 / .price / .row —— 其实一条都没生效，界面「差不多」
    // 所以一直没人发现，直到面交地点改成用户自由输入、26 字地点把卡片撑成 3 行才暴露。
    // 这里静态检查：组件 wxml 用到的、且在 app.wxss 里定义了样式的 class，
    // 必须在**组件自己的 wxss** 里也有定义，否则运行时静默失效。
    {
      const appWxssSrc = fs.readFileSync(
        path.resolve(__dirname, '../miniprogram/app.wxss'), 'utf8'
      );
      const clsOf = src => new Set((src.match(/\.[a-zA-Z][\w-]*/g) || []).map(s => s.slice(1)));
      const globalCls = clsOf(appWxssSrc);
      const compRoot = path.resolve(__dirname, '../miniprogram/components');
      const offenders = [];
      for (const comp of fs.readdirSync(compRoot)) {
        const dir = path.join(compRoot, comp);
        if (!fs.statSync(dir).isDirectory()) continue;
        const wxmlPath = path.join(dir, 'index.wxml');
        if (!fs.existsSync(wxmlPath)) continue;
        const used = new Set();
        for (const m of fs.readFileSync(wxmlPath, 'utf8').matchAll(/class="([^"]*)"/g)) {
          // 跳过含 {{}} 的动态类（如 {{statusClass}}），它们由组件自己的 wxss 覆盖
          if (m[1].indexOf('{{') >= 0) continue;
          for (const c of m[1].split(/\s+/)) if (c) used.add(c);
        }
        const wxssPath = path.join(dir, 'index.wxss');
        const local = fs.existsSync(wxssPath) ? clsOf(fs.readFileSync(wxssPath, 'utf8')) : new Set();
        for (const c of used) {
          if (globalCls.has(c) && !local.has(c)) offenders.push(`${comp}: .${c}`);
        }
      }
      record(
        '组件不依赖全局样式类（隔离下会静默失效）',
        offenders.length === 0,
        offenders.length
          ? '需在组件 wxss 里补定义：' + offenders.join('、')
          : '所有组件都自带样式定义'
      );
    }

    // 「我的」页面是 schoolName 的真正消费者（mine.wxml 直接绑 userInfo.schoolName）。
    // 只断言数据库字段不够 —— schoolId 有值而 schoolName 为空时，
    // 界面上会显示「未选择学校」，字段断言却依然通过。所以这里验 DOM 文本。
    // 注意要轮询等待：mine 的资料是异步拉的，读太早会读到「未选择学校」的
    // 初始帧（userInfo:null 的兜底渲染），属于假失败。
    await mini.reLaunch('/pages/mine/mine');
    await sleep(2400);
    const minePage = await getPage(mini);
    let schoolText = '';
    for (let i = 0; i < 12; i++) {
      schoolText = '';
      if (minePage) {
        try {
          const el = await minePage.$('.school');
          if (el) schoolText = String(await el.text()).trim();
        } catch (e) {
          schoolText = '';
        }
      }
      if (schoolText.indexOf(CONFIG.school) >= 0) break;
      await sleep(1000);
    }
    record(
      '「我的」页面 DOM 渲染出学校名',
      schoolText.indexOf(CONFIG.school) >= 0,
      schoolText ? `DOM 文案「${schoolText}」` : '未能读到 .school 元素'
    );

    /* ---------- 2.5 上线防护：调试入口按环境隐藏 + 全局异常钩子 ---------- */
    const launchGuard = await mini.evaluate(() => {
      let envVersion = 'release';
      try {
        envVersion = wx.getAccountInfoSync().miniProgram.envVersion;
      } catch (e) {
        envVersion = 'release';
      }
      const app = getApp();
      const pages = getCurrentPages();
      const cur = pages.length ? pages[pages.length - 1] : null;
      return {
        envVersion,
        route: cur ? cur.route : '',
        showDebugTools: cur && cur.data ? cur.data.showDebugTools : null,
        hasErrorHook: typeof app.onError === 'function',
        hasRejectionHook: typeof app.onUnhandledRejection === 'function',
        hasNotFoundHook: typeof app.onPageNotFound === 'function'
      };
    });

    // 调试入口**只在开发版（develop）**显示：正式版 release 与体验版 trial 都必须隐藏。
    // ⚠️ 不能写成 envVersion !== 'release' —— 体验版是发给真实同学用的（2026-09-28 收紧）。
    const expectDebug = launchGuard.envVersion === 'develop';
    record(
      '调试入口仅在开发版显示（体验版/正式版都隐藏）',
      launchGuard.route === 'pages/mine/mine' && launchGuard.showDebugTools === expectDebug,
      `envVersion=${launchGuard.envVersion} → showDebugTools=${launchGuard.showDebugTools}（期望 ${expectDebug}）`
    );

    record(
      'App 注册了全局异常钩子',
      launchGuard.hasErrorHook && launchGuard.hasRejectionHook && launchGuard.hasNotFoundHook,
      `onError=${launchGuard.hasErrorHook} / onUnhandledRejection=${launchGuard.hasRejectionHook} / onPageNotFound=${launchGuard.hasNotFoundHook}`
    );

    /* ---------- 3. 云函数契约冒烟 ---------- */
    const calls = [
      ['product/list', 'product', { action: 'list', pageSize: 5 }],
      ['product/myList', 'product', { action: 'myList', pageSize: 5 }],
      ['product/myFavorites', 'product', { action: 'myFavorites', pageSize: 5 }],
      ['message/listConversations', 'message', { action: 'listConversations' }],
      ['order/list', 'order', { action: 'list', role: 'buyer', pageSize: 5 }],
      ['admin/checkAdmin', 'admin', { action: 'checkAdmin' }],
      ['admin/stats', 'admin', { action: 'stats' }]
    ];
    for (const [label, fn, payload] of calls) {
      const r = await callFn(mini, fn, payload);
      record(label, codeOf(r) === 0, brief(r));
    }

    // 错误路径：未知动作必须被明确拒绝，而不是静默成功
    const bad = await callFn(mini, 'product', { action: '__no_such_action__' });
    record('未知动作被拒绝(40004)', codeOf(bad) === 40004, brief(bad));

    /* ---------- 3.5 详情页：失效卡片 + 列表刷新 ---------- */

    // (a) 不存在的商品必须是 40401，不能被当成 50000 服务异常
    const ghostId = 'e2e0000000000000000000000deadbeef';
    const ghost = await callFn(mini, 'product', { action: 'detail', productId: ghostId });
    record('详情：不存在的商品返回 40401', codeOf(ghost) === 40401, brief(ghost));

    // (b) 详情页遇到 404 走「商品不存在」分支，而不是「加载失败」分支。
    //     原来模板只有 wx:else 一个兜底，任何失败都显示成「商品不存在或已被删除」，
    //     现在 404 与网络/服务异常是两条分支。
    await mini.reLaunch(`/pages/detail/detail?id=${ghostId}`);
    await sleep(2500);
    const dInfo = await evalPage(mini);
    const dd = (dInfo && dInfo.data) || {};
    record(
      '详情页区分「商品不存在」与「加载失败」',
      dd.notFound === true && !dd.loadError,
      `notFound=${dd.notFound} loadError="${dd.loadError || ''}"`
    );

    // (c) 列表刷新标记是一次性消费
    const flag = await mini.evaluate(() => {
      const app = getApp();
      if (typeof app.markListRefresh !== 'function' || typeof app.consumeListRefresh !== 'function') {
        return { ok: false, why: '缺少 markListRefresh / consumeListRefresh' };
      }
      app.markListRefresh();
      const first = app.consumeListRefresh();
      const second = app.consumeListRefresh();
      return { ok: first === true && second === false, first, second };
    });
    record('列表刷新标记为一次性消费', !!(flag && flag.ok), JSON.stringify(flag));

    // (d) 关键回归：「标记 → 切回首页 → 首页真的重新拉取」。
    //     旧实现用 getCurrentPages() 去拿首页实例，在 tabBar 页面里永远拿不到
    //     （只返回当前这一个页面），标记是静默空操作 → 发布成功了首页还是旧列表
    //     → 用户点击失效卡片 → 「商品不存在或已被删除」。
    await mini.evaluate(() => { wx.switchTab({ url: '/pages/index/index' }); });
    await sleep(2500);
    const hooked = await mini.evaluate(() => {
      const ps = getCurrentPages();
      const p = ps[ps.length - 1];
      if (!p || p.route !== 'pages/index/index') return { ok: false, why: 'not on index: ' + (p && p.route) };
      globalThis.__loadCount = 0;
      const orig = p.loadList;
      p.loadList = function () {
        globalThis.__loadCount = (globalThis.__loadCount || 0) + 1;
        return orig.apply(this, arguments);
      };
      getApp().markListRefresh();
      return { ok: true };
    });
    await mini.evaluate(() => { wx.switchTab({ url: '/pages/publish/publish' }); });
    await sleep(1500);

    // (e) 发布页是 tabBar 页 → 系统导航栏没有返回箭头，页内必须有「返回首页」入口，
    //     而且点了要真的回得去（写错成 navigateBack 会因为无上一页而静默失败）。
    const pubPage = await getPage(mini);
    let backBtn = null;
    try { backBtn = pubPage ? await pubPage.$('.back-home') : null; } catch (e) { backBtn = null; }
    if (backBtn) await backBtn.tap();
    await sleep(2500);
    const backPath = await mini.evaluate(() => {
      const ps = getCurrentPages();
      const p = ps[ps.length - 1];
      return (p && p.route) || '';
    });
    record(
      '发布页「返回首页」可回到首页',
      !!backBtn && backPath === 'pages/index/index',
      backBtn ? `跳转到 ${backPath || '(空)'}` : '未找到 .back-home 节点'
    );
    // 兜底：这一项万一没回去，别让后面依赖「当前在首页」的断言连环失败
    if (backPath !== 'pages/index/index') {
      await mini.evaluate(() => { wx.switchTab({ url: '/pages/index/index' }); });
      await sleep(2000);
    }

    const loadCount = await mini.evaluate(() => globalThis.__loadCount || 0);
    record(
      '标记刷新后回到首页会重新拉取列表',
      !!(hooked && hooked.ok) && loadCount > 0,
      hooked && hooked.ok ? `loadList 被调用 ${loadCount} 次` : (hooked && hooked.why)
    );

    /* ---------- 3.6 卡片点击事件契约 ---------- */
    // 历史 bug（真机复现）：product-card 的自定义事件名用了内置的 `tap`。
    // 父页面 bind:tap 因此会**收到两次调用**——第一次是自定义事件（带 id），
    // 第二次是原生 tap 冒泡上来的（e.detail 为空）→ 拼出 ?id=undefined
    // → 用户点进自己刚发布的商品，看到「商品不存在或已删除」。
    // 修法：组件根节点 bindtap→catchtap、事件名 tap→cardtap、页面侧兜底判空。
    // 下面三条断言把这个契约钉死，防止有人改回去。
    await mini.reLaunch('/pages/index/index');
    await sleep(3000);

    let firstCardId = await mini.evaluate(() => {
      const ps = getCurrentPages();
      const p = ps[ps.length - 1];
      return (((p.data || {}).list || [])[0] || {})._id || null;
    });

    // 真实暴露过的缺陷（2026-09-17）：这里原先依赖「用户自己有在售商品」。
    // 用户一旦把商品全下架（真实发生过 —— 用户在测试期间自己操作了小程序），
    // 首页空列表 → 断言必挂，但这不是代码坏了，是数据假设错了。
    // 列表空时用脚本自建商品补位（后面「创建测试商品」段会复用它，收尾统一清理）。
    if (!firstCardId && verifyStatus === 'passed') {
      console.log('   [补位] 首页闲置列表为空，先创建测试商品再验卡片契约');
      const pubEarly = await callFn(mini, 'product', {
        action: 'publish',
        title: TEST_TITLE,
        desc: '自动化测试用例商品，测试结束会自动删除',
        price: 9.9,
        images: ['cloud://e2e-test/placeholder.png'],
        categoryId: 'book',
        categoryName: '教材书籍',
        tradePlace: '一号教学楼门口'
      });
      if (codeOf(pubEarly) === 0) {
        createdProductId = (dataOf(pubEarly) || {}).productId;
        await mini.reLaunch('/pages/index/index');
        await sleep(3000);
        firstCardId = await mini.evaluate(() => {
          const ps = getCurrentPages();
          const p = ps[ps.length - 1];
          return (((p.data || {}).list || [])[0] || {})._id || null;
        });
      }
    }

    const cardHosts = await (await mini.currentPage()).$$('.pcard-cell').catch(() => []);
    record(
      '卡片宿主节点可被自动化选中',
      cardHosts.length > 0,
      `找到 ${cardHosts.length} 个 .pcard-cell`
    );

    if (cardHosts.length && firstCardId) {
      // (a) 原生 tap 冒泡那条旧通路必须彻底断掉：
      //     往组件宿主节点上派发一个空的 tap（等价于当年那第二次调用），
      //     页面必须**不动**。
      const depthBefore = (await mini.pageStack()).length;
      await cardHosts[0].trigger('tap', {});
      await sleep(1500);
      const depthAfterTap = (await mini.pageStack()).length;
      record(
        '内置事件名 tap 不再触发卡片跳转',
        depthAfterTap === depthBefore,
        `页面栈深度 ${depthBefore} → ${depthAfterTap}（期望不变）`
      );

      // (b) 自定义事件 cardtap 必须带着正确的 id 跳详情
      await cardHosts[0].trigger('cardtap', { id: firstCardId });
      await sleep(2500);
      const cardInfo = await evalPage(mini);
      const cd = (cardInfo && cardInfo.data) || {};
      record(
        '点击卡片 → 详情页拿到的 id 正确',
        !!cardInfo && cardInfo.route === 'pages/detail/detail' && cd.productId === firstCardId,
        `route=${cardInfo && cardInfo.route} productId=${JSON.stringify(cd.productId)}`
      );

      // (c) 历史症状本身：?id=undefined 必须在客户端就拦下，不发请求
      await mini.reLaunch('/pages/detail/detail?id=undefined');
      await sleep(2200);
      const badInfo = await evalPage(mini);
      const bad = (badInfo && badInfo.data) || {};
      record(
        '详情页拦截 ?id=undefined（不发请求）',
        bad.productId === '' && bad.notFound === true && !bad.loadError,
        `productId=${JSON.stringify(bad.productId)} notFound=${bad.notFound}`
      );
    } else {
      record('卡片点击事件契约', false, '首页没有可点的卡片，已跳过');
    }

    /* ---------- 4. 下架 / 重新上架（真实点击） ---------- */
    // 铁律：**绝不拿用户的真实商品做实验**。
    // 旧写法是 myList(status:'on_sale')[0] —— 也就是用户自己的第一个在售商品，
    // 然后对它点「下架 / 重新上架」。中途任何一步失败，用户的商品就被留在
    // 下架状态（正是本次线上反馈的现象）。现在固定只用本脚本自己创建的商品，
    // 标题带 [自动化测试]，收尾时会被清理。
    // 标题常量已提到顶部声明（卡片契约段补位时也要用）

    // 发布需要「已认证」。测试账号若未认证，临时走一遍真实认证流程，
    // 测试结束后用 admin/resetVerify 复位（不要用 auditVerify(pass:false)，
    // 那会给用户留下一个「已驳回」状态）。
    if (verifyStatus !== 'passed' && !tempVerified) {
      const sub = await callFn(mini, 'user', {
        action: 'submitVerify',
        realName: '自动化测试',
        studentNo: 'ZZTEST' + String(Date.now()).slice(-6),
        schoolId: userInfo.schoolId || 'e2e-school',
        schoolName: userInfo.schoolName || '自动化测试学校'
      });
      const aud = await callFn(mini, 'admin', {
        action: 'auditVerify',
        targetUserId: userInfo._id,
        pass: true
      });
      tempVerified = codeOf(sub) === 0 && codeOf(aud) === 0;
      record('临时认证（测试用）', tempVerified, tempVerified ? 'pending → passed' : brief(sub) + ' / ' + brief(aud));
    }

    // 先看上次跑测是否留下了可复用的测试商品
    const mine = await callFn(mini, 'product', { action: 'myList', status: 'on_sale', pageSize: 20 });
    let target = ((dataOf(mine) || {}).list || []).find(x => x.title === TEST_TITLE) || null;
    if (target) createdProductId = target._id;

    if (!target) {
      const pub = await callFn(mini, 'product', {
        action: 'publish',
        title: TEST_TITLE,
        desc: '自动化测试用例商品，测试结束会自动删除',
        price: 9.9,
        images: ['cloud://e2e-test/placeholder.png'],
        categoryId: 'book',
        categoryName: '教材书籍',
        tradePlace: '一号教学楼门口'
      });
      if (codeOf(pub) === 0) {
        createdProductId = (dataOf(pub) || {}).productId;
        const again = await callFn(mini, 'product', { action: 'myList', status: 'on_sale', pageSize: 20 });
        target = ((dataOf(again) || {}).list || []).find(x => x._id === createdProductId) || null;
        record('创建测试商品', !!target, createdProductId || '');
      } else {
        record('创建测试商品', false, '无法创建（' + brief(pub) + '），跳过下架点击测试');
      }
    }

    // 防御：万一选中的不是测试商品（例如标题被改过），宁可跳过也不能碰用户数据
    if (target && target.title !== TEST_TITLE) {
      record('下架/上架用例只用自建测试商品', false,
        `意外选中「${target.title}」，已跳过以免改动用户真实数据`);
      target = null;
    } else if (target) {
      record('下架/上架用例只用自建测试商品', true, `${target.title} / ${target._id}`);
    }

    if (target) {
      // 4.1 打开「我的发布」，确认按钮存在
      await mini.reLaunch('/pages/myProducts/myProducts?status=on_sale');
      await sleep(2000);
      const page = await getPage(mini);
      const info = await evalPage(mini);
      let list = ((info && info.data) || {}).list || [];
      let btn = null;
      if (page) {
        try { btn = (await page.$$('.ra-btn'))[0]; } catch (e) { btn = null; }
      }
      record(
        '「我的发布」渲染出下架按钮',
        list.length > 0 && (!page || !!btn),
        btn ? `按钮文案「${(await btn.text()).trim()}」，共 ${list.length} 条` : `共 ${list.length} 条（DOM 元素读取受限）`
      );
      await screenshot(mini, '01-myProducts-before');

      // 只认自己创建的那条测试商品。只有它恰好排在第一行时，
      // DOM 里的第一个 .ra-btn 才是它的按钮，否则就可能点到用户别的商品上。
      // 页面渲染取不到时兜底用云端那条测试商品的数据——方法调用路径
      // 只需要 id/status/title，不依赖页面渲染。
      const rowIdx = list.findIndex(x => x._id === createdProductId);
      const row = rowIdx >= 0 ? list[rowIdx] : null;
      const rowBtn = rowIdx === 0 ? btn : null;
      const rowData = row || { _id: target._id, status: target.status, title: target.title };
      record(
        '「我的发布」里能找到测试商品那一条',
        !!row,
        row ? `${row.title}（第 ${rowIdx + 1} 行）` : `页面列表 ${list.length} 条里没有，改用云端数据`
      );

      // 4.2 让原生确认弹窗自动点「确定」——原生弹窗无法用自动化点击
      await mini.evaluate(() => {
        if (!wx.__origShowModal) wx.__origShowModal = wx.showModal;
        wx.showModal = o => {
          const res = { confirm: true, cancel: false };
          try { o && o.success && o.success(res); } catch (e) {}
          try { o && o.complete && o.complete(res); } catch (e) {}
        };
      });

      const targetId = rowData._id;
      const beforeStatus = rowData.status;

      // 4.3 点击「下架」：优先真实 DOM 点击；DOM 取不到时退化为直接调页面方法
      const tapShelf = async (item, el) => {
        if (el) { await el.tap(); return 'dom-tap'; }
        await mini.evaluate(
          (id, status, title) => {
            const ps = getCurrentPages();
            const p = ps[ps.length - 1];
            p.onToggleShelf({ currentTarget: { dataset: { id, status, title } } });
          },
          item._id,
          item.status,
          item.title
        );
        return 'method-call';
      };

      const how1 = await tapShelf(rowData, rowBtn);
      await sleep(2000);
      const afterCloud = await callFn(mini, 'product', { action: 'myList', pageSize: 10 });
      const afterRow = ((dataOf(afterCloud) || {}).list || []).find(x => x._id === targetId) || null;
      record(
        '点击下架 → 云函数落库',
        !!afterRow && afterRow.status === 'off_shelf',
        afterRow ? `${beforeStatus} → ${afterRow.status}（${how1}）` : '列表中已找不到该商品'
      );
      await screenshot(mini, '02-myProducts-off');

      // 4.3b 已下架的商品，详情页必须仍能正常打开（顶部显示「已下架」）。
      //      这里曾经被用户误判成「商品不存在」——因为详情页原先只有一条
      //      wx:else 兜底，任何失败都显示同一句话。现在要保证 off_shelf 不报错。
      const offDetail = await callFn(mini, 'product', {
        action: 'detail',
        productId: targetId
      });
      const offProd = (dataOf(offDetail) || {}).product || {};
      record(
        '已下架商品详情页可正常打开(不报不存在)',
        codeOf(offDetail) === 0 && offProd.status === 'off_shelf',
        `code=${codeOf(offDetail)} status=${offProd.status || '-'}`
      );

      // 4.4 重新上架：切到「已下架」标签再点
      await mini.evaluate(() => {
        const ps = getCurrentPages();
        const p = ps[ps.length - 1];
        p.onTabTap({ currentTarget: { dataset: { key: 'off_shelf' } } });
      });
      await sleep(1800);
      const info2 = await evalPage(mini);
      const offList = ((info2 && info2.data) || {}).list || [];
      let btn2 = null;
      try { btn2 = (await page.$$('.ra-btn'))[0]; } catch (e) { btn2 = null; }
      const offIdx = offList.findIndex(x => x._id === targetId);
      const offRow = offIdx >= 0 ? offList[offIdx] : null;
      const offBtn = offIdx === 0 ? btn2 : null;
      if (offList.length) {
        const t2 = btn2 ? (await btn2.text()).trim() : '（DOM 未取到）';
        const how2 = await tapShelf(
          offRow || { _id: targetId, status: 'off_shelf', title: target.title },
          offBtn
        );
        await sleep(2000);
        const backCloud = await callFn(mini, 'product', { action: 'myList', pageSize: 10 });
        const backRow = ((dataOf(backCloud) || {}).list || []).find(x => x._id === targetId) || null;
        record(
          '点击重新上架 → 云函数落库',
          !!backRow && backRow.status === 'on_sale',
          `按钮文案「${t2}」，结果 ${backRow ? backRow.status : '未找到'}（${how2}）`
        );
      } else {
        record('点击重新上架 → 云函数落库', false, '已下架标签下没有条目');
      }

      // 4.5 复原 showModal
      await mini.evaluate(() => {
        if (wx.__origShowModal) { wx.showModal = wx.__origShowModal; delete wx.__origShowModal; }
      });
    }

    /* ---------- 5. 头像昵称 + 图片内容安全（真实链路） ---------- */

    const origProfile = await callFn(mini, 'user', { action: 'getProfile' });
    origUser = (dataOf(origProfile) || {}).userInfo || {};
    testStartTs = Date.now();

    // 让 uploadImage 用真实 _id 当路径前缀，
    // 否则 upload/deleteFiles 的「只能删自己的文件」校验会拦住清理
    await mini.evaluate(uid => {
      const app = getApp();
      app.globalData.userInfo = Object.assign({}, app.globalData.userInfo || {}, { _id: uid });
    }, origUser._id);

    // 在模拟器文件系统里写一张 1x1 的 PNG：真实图片才能走完整条链路
    const mk = await mini.evaluate(() => {
      try {
        const fsm = wx.getFileSystemManager();
        const p = wx.env.USER_DATA_PATH + '/e2e-avatar.png';
        fsm.writeFileSync(
          p,
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64'
        );
        return { ok: true, path: p };
      } catch (e) {
        return { ok: false, err: (e && (e.errMsg || e.message)) || String(e) };
      }
    });
    record('模拟器内创建测试图片', !!(mk && mk.ok), mk && mk.ok ? mk.path : (mk && mk.err));

    if (mk && mk.ok) {
      // 真实上传到云存储
      await mini.evaluate((fp, uid) => {
        globalThis.__A = { done: false };
        // 云存储路径里必须带自己的 _id，否则 upload/deleteFiles 的
        // 「只能删自己的文件」校验会把清理拦下来
        wx.cloud
          .uploadFile({ filePath: fp, cloudPath: 'e2e/' + uid + '/' + Date.now() + '-avatar.png' })
          .then(r => { globalThis.__A = { done: true, ok: true, fileID: r.fileID }; })
          .catch(e => { globalThis.__A = { done: true, ok: false, err: (e && (e.errMsg || e.message)) || String(e) }; });
      }, mk.path, origUser._id);
      let up = null;
      for (let i = 0; i < 40; i++) {
        up = await mini.evaluate(() => globalThis.__A);
        if (up && up.done) break;
        await sleep(400);
      }
      record('图片上传云存储', !!(up && up.ok), up && up.ok ? String(up.fileID).slice(0, 52) : (up && up.err));
      avatarFileID = (up && up.ok && up.fileID) || '';
    }

    // 图片内容安全：真实送检 + 接口异常时的降级行为
    if (avatarFileID) {
      const sec = await callFn(mini, 'upload', { action: 'imgSecCheck', fileIDs: [avatarFileID] });
      const sd = dataOf(sec) || {};
      record('图片内容安全送检（真实图片）', codeOf(sec) === 0 && sd.pass === true, brief(sec));

      // 文件不存在 → 检测接口必然报错。此时必须降级放行，
      // 否则内容安全接口一抖动，用户就发不出商品了
      const secBad = await callFn(mini, 'upload', {
        action: 'imgSecCheck',
        fileIDs: ['cloud://e2e-not-exist/e2e-missing.png']
      });
      const sb = dataOf(secBad) || {};
      record('检测异常时降级放行', codeOf(secBad) === 0 && sb.pass === true, brief(secBad));
    }

    // 头像昵称：真实点击「保存」
    await mini.reLaunch('/pages/profile/profile');
    await sleep(1800);
    const pfPage = await getPage(mini);
    if (pfPage && mk && mk.ok) {
      await pfPage.callMethod('onChooseAvatar', { detail: { avatarUrl: mk.path } });
      await pfPage.callMethod('onNickChange', { detail: { value: '自动化测试昵称' } });
      await sleep(400);

      // 真点 DOM 按钮，而不是直接调 onSave —— 要验的就是「按钮点击 → 落库」这一整条
      let saveBtn = null;
      try { saveBtn = await pfPage.$('.btn-primary'); } catch (e) { saveBtn = null; }
      const howSave = saveBtn ? 'dom-tap' : 'method-call';
      if (saveBtn) await saveBtn.tap();
      else await pfPage.callMethod('onSave');

      await sleep(3500);
      profileTouched = true;

      const after = await callFn(mini, 'user', { action: 'getProfile' });
      const au = (dataOf(after) || {}).userInfo || {};
      record('编辑资料 → 昵称落库', au.nickName === '自动化测试昵称', `nickName = ${au.nickName}（${howSave}）`);
      record(
        '编辑资料 → 头像上传并落库',
        typeof au.avatarUrl === 'string' && au.avatarUrl.indexOf('cloud://') === 0,
        String(au.avatarUrl).slice(0, 56)
      );
      if (typeof au.avatarUrl === 'string' && au.avatarUrl.indexOf('cloud://') === 0) {
        // 真实事故（2026-09-17 第二次）：测试期间用户自己也在用小程序，
        // 这里读到的可能是**用户刚上传的真实头像**（.jpeg），若无条件记进
        // savedAvatarFileID，收尾 deleteFiles 会把用户的头像文件当测试垃圾删掉。
        // 防线：只认「本次测试产生的文件」—— avatars/ 目录 + png 后缀（测试图是 1x1 PNG）
        // + 文件名时间戳在测试开始之后（留 60s 容差）。不满足就跳过删除并明示。
        const m = au.avatarUrl.match(/avatars\/[^/]+\/(\d+)-\d+\.png$/);
        if (m && testStartTs && Number(m[1]) >= testStartTs - 60000) {
          savedAvatarFileID = au.avatarUrl;
        } else {
          console.log('   ⚠️ 保存后头像不是测试文件（用户可能同时在操作），不纳入清理：' + String(au.avatarUrl).slice(-60));
        }
      }
      // 注意：profile 保存成功后会 setTimeout 700ms 自动 goBack 回「我的」，
      // 所以这张图拍到的是**保存后的「我的」页**（正好可以肉眼核对新昵称与校名），
      // 而不是编辑资料表单。命名如实反映这一点。
      await screenshot(mini, '03-mine-after-save');
    } else {
      record('编辑资料页可操作', false, pfPage ? '测试图片创建失败' : '未能取到页面实例');
    }

    /* ---------- 6. 分享 ---------- */

    await mini.reLaunch('/pages/index/index');
    await sleep(1600);
    // 实例取不到就等于「没测」，别让它伪装成功能失败：getPage 内部已重试约 8s，
    // 仍拿不到就显式提示一次（这种情况是环境问题，不是 onShareAppMessage 坏了）
    const idxPage = await getPage(mini);
    if (!idxPage) console.log('   ⚠️ 仍未取到 index 页实例，本项结果不可信（环境问题）');
    let shareIdx = null;
    try { if (idxPage) shareIdx = await idxPage.callMethod('onShareAppMessage'); } catch (e) { shareIdx = null; }
    record('首页可转发', !!(shareIdx && shareIdx.path === '/pages/index/index'), JSON.stringify(shareIdx));

    if (target) {
      await mini.reLaunch('/pages/detail/detail?id=' + target._id);
      await sleep(2200);
      const dtPage = await getPage(mini);
      let shareDt = null;
      try { if (dtPage) shareDt = await dtPage.callMethod('onShareAppMessage'); } catch (e) { shareDt = null; }
      record(
        '详情页可转发（带商品 id）',
        !!(shareDt && String(shareDt.path).indexOf('id=' + target._id) > -1),
        JSON.stringify(shareDt && { title: shareDt.title, path: shareDt.path })
      );
    }

    /* ---------- 7. 订单 / 消息 / 举报 守卫（非法入参必须明确报错，且不落库） ---------- */

    if (target) {
      // 自己的商品不能自己买：这道校验必须挡在写库之前
      const selfBuy = await callFn(mini, 'order', { action: 'create', productId: target._id });
      record('订单：不能买自己的商品(40304)', codeOf(selfBuy) === 40304, brief(selfBuy));
    }

    const oParam = await callFn(mini, 'order', { action: 'updateStatus', orderId: 'x' });
    record('订单：缺 op 被拒(40001)', codeOf(oParam) === 40001, brief(oParam));

    const oBadOp = await callFn(mini, 'order', { action: 'updateStatus', orderId: 'x', op: '__bad__' });
    record('订单：非法 op 被拒(40303)', codeOf(oBadOp) === 40303, brief(oBadOp));

    const oMiss = await callFn(mini, 'order', {
      action: 'updateStatus',
      orderId: 'no-such-order-id',
      op: 'cancel'
    });
    record('订单：订单不存在(40402)', codeOf(oMiss) === 40402, brief(oMiss));

    // 消息：不能给自己发（消息安全检测走的是同一套校验）
    const selfMsg = await callFn(mini, 'message', {
      action: 'send',
      toId: origUser._id,
      content: '自动化测试消息（应被拒绝，不会落库）'
    });
    record('消息：不能给自己发(40308)', codeOf(selfMsg) === 40308, brief(selfMsg));

    const nobody = await callFn(mini, 'message', {
      action: 'send',
      toId: 'no-such-user-id',
      content: '自动化测试消息（应被拒绝，不会落库）'
    });
    record('消息：对方不存在(40401)', codeOf(nobody) === 40401, brief(nobody));

    const repParam = await callFn(mini, 'product', {
      action: 'report',
      targetType: 'product',
      targetId: target ? target._id : 'x'
    });
    record('举报：缺 reason 被拒(40001)', codeOf(repParam) === 40001, brief(repParam));

    /* ---------- 8. 管理端只读接口 ---------- */

    const adminReads = [
      ['admin/listVerifyRequests', 'admin', { action: 'listVerifyRequests', pageSize: 5 }],
      ['admin/listReports', 'admin', { action: 'listReports', pageSize: 5 }],
      ['admin/listProducts', 'admin', { action: 'listProducts', pageSize: 5 }]
    ];
    for (const [label, fn, payload] of adminReads) {
      const r = await callFn(mini, fn, payload);
      record(label, codeOf(r) === 0, brief(r));
    }

    const blockBad = await callFn(mini, 'admin', { action: 'blockProduct', productId: 'no-such-id', op: 'block' });
    record('管理端：操作不存在的商品被拒', codeOf(blockBad) !== 0, brief(blockBad));

    /* ---------- 9. 新功能回归：退出登录 / 头像私聊 / 校园跑腿 ---------- */

    /* 9.1 退出登录 */

    const logoutApi = await mini.evaluate(() => {
      const app = getApp();
      return {
        hasLogout: typeof app.logout === 'function',
        hasSetLoggedOut: typeof app.setLoggedOut === 'function'
      };
    });
    record(
      '退出登录：App 暴露 logout / setLoggedOut',
      !!(logoutApi && logoutApi.hasLogout && logoutApi.hasSetLoggedOut),
      JSON.stringify(logoutApi)
    );

    // 核心回归：点了「退出登录」之后，**不能**又被 ensureLogin 静默登回去。
    // （能静默登回去的话，这个按钮点了等于没点。）
    const logoutBehavior = await mini.evaluate(async () => {
      const app = getApp();
      app.setLoggedOut(true);
      app.globalData.userInfo = null;
      wx.removeStorageSync('userInfo');

      let blocked = false;
      try {
        await app.ensureLogin();
      } catch (e) {
        blocked = !!e && e.code === 40101;
      }
      const flag = app.globalData.loggedOut === true;

      // 还原现场：不清掉的话后面所有用例都会被判成未登录
      app.setLoggedOut(false);
      app.globalData.userInfo = null;
      wx.removeStorageSync('userInfo');

      let restored = false;
      try {
        await app.ensureLogin();
        restored = !!app.globalData.userInfo;
      } catch (e) {
        restored = false;
      }
      return { blocked, flag, restored };
    });
    record(
      '退出登录：退出后不自动登录、重新登录后恢复',
      !!(logoutBehavior && logoutBehavior.blocked && logoutBehavior.flag && logoutBehavior.restored),
      JSON.stringify(logoutBehavior)
    );

    await mini.reLaunch('/pages/mine/mine');
    await sleep(2600);
    const minePageLogout = await getPage(mini);
    const logoutBtns = minePageLogout ? await minePageLogout.$$('.logout-btn') : [];
    record(
      '我的页存在「退出登录」入口',
      !!(logoutBtns && logoutBtns.length > 0),
      `节点数 ${logoutBtns ? logoutBtns.length : 0}`
    );

    /* 9.2 头像私聊 / 用户主页 */

    const myProf = await callFn(mini, 'user', { action: 'getProfile' });
    const meId = ((dataOf(myProf) || {}).userInfo || {})._id || '';

    const pubProf = await callFn(mini, 'user', { action: 'getPublicProfile', userId: meId });
    const pubData = dataOf(pubProf) || {};
    const pubUser = pubData.userInfo || {};
    record(
      '用户主页：返回公开资料',
      codeOf(pubProf) === 0 && !!pubUser.nickName && pubData.isSelf === true,
      `nickName=${pubUser.nickName} isSelf=${pubData.isSelf}`
    );

    // 隐私红线：点头像能看到别人主页，所以这里绝对不能带学号和真名
    record(
      '用户主页不泄露学号/真名',
      !('studentNo' in pubUser) && !('realName' in pubUser),
      `返回字段：${Object.keys(pubUser).join(',')}`
    );

    const ghostUser = await callFn(mini, 'user', {
      action: 'getPublicProfile',
      userId: 'no-such-user-id'
    });
    record('用户主页：不存在的用户返回 40401', codeOf(ghostUser) === 40401, brief(ghostUser));

    await mini.reLaunch(`/pages/userProfile/userProfile?userId=${meId}`);
    await sleep(2600);
    const upInfo = await evalPage(mini);
    const upd = (upInfo && upInfo.data) || {};
    record(
      '用户主页可打开且 isSelf 正确',
      !!upInfo && upInfo.route === 'pages/userProfile/userProfile' && upd.isSelf === true && !!upd.userInfo,
      `route=${upInfo && upInfo.route} isSelf=${upd.isSelf}`
    );

    await mini.reLaunch('/pages/userProfile/userProfile?userId=undefined');
    await sleep(2200);
    const upBadInfo = await evalPage(mini);
    const ubd = (upBadInfo && upBadInfo.data) || {};
    record(
      '用户主页拦截 ?userId=undefined（不发请求）',
      ubd.userId === '' && ubd.notFound === true && !ubd.loadError,
      `userId=${JSON.stringify(ubd.userId)} notFound=${ubd.notFound}`
    );

    // 卡片上的卖家行 → 进对方主页（点头像私聊的通路）
    await mini.reLaunch('/pages/index/index');
    await sleep(2600);
    const idxPage2 = await getPage(mini);
    const cardHosts2 = idxPage2 ? await idxPage2.$$('.pcard-cell') : [];
    const idxInfo2 = await evalPage(mini);
    const firstItem2 = (((idxInfo2 || {}).data || {}).list || [])[0] || {};

    if (cardHosts2 && cardHosts2.length > 0 && firstItem2.sellerId) {
      await cardHosts2[0].trigger('sellertap', { sellerId: firstItem2.sellerId });
      await sleep(2600);
      const afterSeller = await evalPage(mini);
      const asd = (afterSeller && afterSeller.data) || {};
      record(
        '卡片卖家事件 sellertap → 进入用户主页',
        !!afterSeller &&
          afterSeller.route === 'pages/userProfile/userProfile' &&
          asd.userId === firstItem2.sellerId,
        `route=${afterSeller && afterSeller.route} userId=${asd.userId}`
      );
    } else {
      record('卡片卖家事件 sellertap → 进入用户主页', false, '首页没有卡片，已跳过');
    }

    /* 9.3 校园跑腿 */

    const ERRAND_TITLE = '[自动化测试] 跑腿任务';
    let errandId = '';

    // 先清掉历史遗留的测试任务，避免反复跑越积越多。只删标题带测试标记的。
    const oldErrands = await callFn(mini, 'product', { action: 'errandMyList', role: 'publisher' });
    for (const row of ((dataOf(oldErrands) || {}).list || [])) {
      if (/自动化测试/.test(row.title || '')) {
        await callFn(mini, 'product', { action: 'remove', productId: row._id });
      }
    }

    // 跑腿允许没有图片（「帮我去驿站拿个快递」往往就是纯文字）
    const pubErrand = await callFn(mini, 'product', {
      action: 'publish',
      type: 'errand',
      title: ERRAND_TITLE,
      desc: '自动化测试用例跑腿任务，测试结束会自动删除',
      price: 5,
      images: [],
      errandType: 'express',
      errandTypeName: '代取快递',
      fromPlace: '菜鸟驿站',
      toPlace: '3 栋宿舍楼下',
      deadline: Date.now() + 2 * 3600 * 1000
    });
    errandId = (dataOf(pubErrand) || {}).productId || '';
    record('跑腿：发布任务（无图也可）', codeOf(pubErrand) === 0 && !!errandId, brief(pubErrand));

    const errandList = await callFn(mini, 'product', { action: 'list', type: 'errand', pageSize: 20 });
    record(
      '跑腿：出现在跑腿列表',
      ((dataOf(errandList) || {}).list || []).some(x => x._id === errandId),
      `errandId=${errandId}`
    );

    // 搜索页支持按类型搜索（首页跑腿 tab 点搜索自动带 type=errand）：
    // 同一个关键词，errand 侧必须能搜到这条任务，goods 侧必须搜不到它。
    // 守的是「搜索跑腿」这条链路不在未来被改回「只搜闲置」。
    const searchErrand = await callFn(mini, 'product', { action: 'list', type: 'errand', keyword: '跑腿任务', pageSize: 20 });
    const searchGoods = await callFn(mini, 'product', { action: 'list', keyword: '跑腿任务', pageSize: 20 });
    record(
      '搜索：跑腿关键词按类型隔离',
      ((dataOf(searchErrand) || {}).list || []).some(x => x._id === errandId) &&
        !((dataOf(searchGoods) || {}).list || []).some(x => x._id === errandId),
      `errand侧命中=${((dataOf(searchErrand) || {}).list || []).some(x => x._id === errandId)} / goods侧命中=${((dataOf(searchGoods) || {}).list || []).some(x => x._id === errandId)}`
    );

    // 关键：两类内容不能串。闲置列表和我的发布里都不该出现跑腿任务。
    const goodsList = await callFn(mini, 'product', { action: 'list', pageSize: 20 });
    record(
      '跑腿：不会混进「闲置」列表',
      !!errandId && !((dataOf(goodsList) || {}).list || []).some(x => x._id === errandId),
      `商品列表 ${(((dataOf(goodsList) || {}).list) || []).length} 条`
    );

    const myPubList = await callFn(mini, 'product', { action: 'myList', pageSize: 20 });
    record(
      '跑腿：不会混进「我的发布」',
      !!errandId && !((dataOf(myPubList) || {}).list || []).some(x => x._id === errandId),
      `我的发布 ${(((dataOf(myPubList) || {}).list) || []).length} 条`
    );

    const eDetail = await callFn(mini, 'product', { action: 'detail', productId: errandId });
    const eProduct = (dataOf(eDetail) || {}).product || {};
    record(
      '跑腿：详情带上 type / errandStatus / 取送地点',
      eProduct.type === 'errand' && eProduct.errandStatus === 'open' && eProduct.fromPlace === '菜鸟驿站',
      `type=${eProduct.type} errandStatus=${eProduct.errandStatus} from=${eProduct.fromPlace}`
    );

    // 跑腿的「完成时间」是**未来**时间，不能用「过去时间」语义的 formatTime
    // （真实 bug，2026-09-18 发现：卡片显示「截止 刚刚」、详情页显示「刚刚 前」）
    {
      const util = require(path.resolve(__dirname, '../miniprogram/utils/util.js'));
      const in3h = new Date(Date.now() + 3 * 3600 * 1000);
      const oldStyle = util.formatTime(in3h);
      const fd = util.formatDeadline(in3h);
      record(
        '跑腿截止时间：未来时间不会被显示成「刚刚」',
        !!fd && fd.indexOf('刚刚') < 0 && fd.indexOf('今天') === 0,
        `3 小时后 → 「${fd}」（过去时间语义的 formatTime 会给出「${oldStyle}」）`
      );

      const tomorrow = new Date(Date.now() + 26 * 3600 * 1000);
      const past = new Date(Date.now() - 3600 * 1000);
      const far = new Date(Date.now() + 30 * 86400000);
      record(
        '截止时间：明天 / 已截止 分支正确，卡片短格式不带时分',
        util.formatDeadline(tomorrow).indexOf('明天') === 0 &&
          util.formatDeadline(tomorrow, true).indexOf('明天') === 0 &&
          util.formatDeadline(past) === '已截止' &&
          util.formatDeadline(far, true).indexOf(':') < 0,
        `明天 → 「${util.formatDeadline(tomorrow)}」；过期 → 「${util.formatDeadline(past)}」；远处(短) → 「${util.formatDeadline(far, true)}」`
      );

      // 页面级：详情页真的渲染出「非刚刚」的到期文案
      await mini.reLaunch(`/pages/detail/detail?id=${errandId}`);
      await sleep(3000);
      let dlText = '';
      for (let i = 0; i < 6; i++) {
        dlText = await mini
          .evaluate(() => {
            const ps = getCurrentPages();
            const p = ps[ps.length - 1];
            return ((p.data || {}).deadlineText) || '';
          })
          .catch(() => '');
        if (dlText) break;
        await sleep(700);
      }
      record(
        '详情页「完成时间」渲染出真实到期时间',
        !!dlText && dlText.indexOf('刚刚') < 0,
        `页面 deadlineText = 「${dlText} 前」`
      );
    }

    // 删除只对「已结束」的任务开放：open 的列表里还有人能接、taken 的有人正在跑，
    // 删了会让对方的东西凭空消失 → 必须被 40312 拦下
    const delOpenErrand = await callFn(mini, 'product', { action: 'errandRemove', productId: errandId });
    record('跑腿：进行中的任务不能删除(40312)', codeOf(delOpenErrand) === 40312, brief(delOpenErrand));

    const selfAccept = await callFn(mini, 'product', { action: 'errandAccept', productId: errandId });
    record('跑腿：不能接自己发布的任务(40310)', codeOf(selfAccept) === 40310, brief(selfAccept));

    const selfFinish = await callFn(mini, 'product', { action: 'errandFinish', productId: errandId });
    record('跑腿：未接单时不能确认完成(40312)', codeOf(selfFinish) === 40312, brief(selfFinish));

    const acceptGoodsId = (target && target._id) || 'no-such-id';
    const acceptGoods = await callFn(mini, 'product', { action: 'errandAccept', productId: acceptGoodsId });
    record(
      '跑腿：对非跑腿内容调用接单被拒',
      [40005, 40401].indexOf(codeOf(acceptGoods)) >= 0,
      brief(acceptGoods)
    );

    // 同一条守卫适用于删除：不能拿闲置商品当跑腿任务删掉
    const delGoodsAsErrand = await callFn(mini, 'product', { action: 'errandRemove', productId: acceptGoodsId });
    record(
      '跑腿：对非跑腿内容调用删除被拒',
      [40005, 40401].indexOf(codeOf(delGoodsAsErrand)) >= 0,
      brief(delGoodsAsErrand)
    );

    const pastDeadline = await callFn(mini, 'product', {
      action: 'publish',
      type: 'errand',
      title: ERRAND_TITLE + '过期',
      desc: '自动化测试：过去的截止时间',
      price: 5,
      errandType: 'express',
      fromPlace: 'a',
      toPlace: 'b',
      deadline: Date.now() - 3600 * 1000
    });
    record('跑腿：过去的完成时间被拒(40006)', codeOf(pastDeadline) === 40006, brief(pastDeadline));

    const badErrandType = await callFn(mini, 'product', {
      action: 'publish',
      type: 'errand',
      title: ERRAND_TITLE + '类型',
      desc: '自动化测试：非法跑腿类型',
      price: 5,
      errandType: 'not-a-real-type',
      fromPlace: 'a',
      toPlace: 'b',
      deadline: Date.now() + 3600 * 1000
    });
    record('跑腿：非法类型被拒(40002)', codeOf(badErrandType) === 40002, brief(badErrandType));

    // 真实交互：首页点「校园跑腿」tab，刚发布的任务应该出现在列表里
    await mini.reLaunch('/pages/index/index');
    await sleep(2600);
    const homePage = await getPage(mini);
    const typeTabs = homePage ? await homePage.$$('.type-tab') : [];
    if (typeTabs && typeTabs.length >= 2) {
      await typeTabs[1].tap();
      await sleep(2800);
    }
    const homeInfo = await evalPage(mini);
    const hd = (homeInfo && homeInfo.data) || {};
    record(
      '首页：切到跑腿 tab 并显示刚发布的任务',
      hd.contentType === 'errand' &&
        (((hd.list) || []).some(x => x._id === errandId)),
      `contentType=${hd.contentType} 列表 ${((hd.list) || []).length} 条`
    );

    const cancelErrand = await callFn(mini, 'product', { action: 'errandCancel', productId: errandId });
    record('跑腿：发布者可以取消任务', codeOf(cancelErrand) === 0, brief(cancelErrand));

    const afterCancel = await callFn(mini, 'product', { action: 'detail', productId: errandId });
    const canceledProduct = (dataOf(afterCancel) || {}).product || {};
    record(
      '跑腿：取消后状态为 canceled',
      canceledProduct.errandStatus === 'canceled',
      `errandStatus=${canceledProduct.errandStatus}`
    );

    const listAfterCancel = await callFn(mini, 'product', { action: 'list', type: 'errand', pageSize: 20 });
    record(
      '跑腿：取消后不再出现在跑腿列表',
      !((dataOf(listAfterCancel) || {}).list || []).some(x => x._id === errandId),
      `errandId=${errandId}`
    );

    const myErrandList = await callFn(mini, 'product', { action: 'errandMyList', role: 'publisher' });
    record(
      '跑腿：我的跑腿能查到（含已取消）',
      !!errandId && ((dataOf(myErrandList) || {}).list || []).some(x => x._id === errandId),
      `我的跑腿 ${(((dataOf(myErrandList) || {}).list) || []).length} 条`
    );

    // 已取消的任务允许发布者删掉（列表里清理掉，免得一直堆着）
    const delCanceled = await callFn(mini, 'product', { action: 'errandRemove', productId: errandId });
    record('跑腿：已取消的任务可以删除', codeOf(delCanceled) === 0, brief(delCanceled));

    const afterDel = await callFn(mini, 'product', { action: 'errandMyList', role: 'publisher' });
    record(
      '跑腿：删除后不再出现在我的跑腿',
      !!errandId && !((dataOf(afterDel) || {}).list || []).some(x => x._id === errandId),
      `我的跑腿 ${(((dataOf(afterDel) || {}).list) || []).length} 条`
    );

    const errRunnerList = await callFn(mini, 'product', { action: 'errandMyList', role: 'runner' });
    record(
      '跑腿：我接的（runner）为空且不报错',
      codeOf(errRunnerList) === 0,
      `我接的 ${(((dataOf(errRunnerList) || {}).list) || []).length} 条`
    );

    if (errandId) {
      // 上面已经用 errandRemove 删掉了，这里改成复核「删掉之后真的查不到了」。
      // （原来这一步是调 product/remove 清理，现在删的动作本身就是被测对象）
      const goneErrand = await callFn(mini, 'product', { action: 'detail', productId: errandId });
      record('跑腿：删除后详情不可再访问', codeOf(goneErrand) === 40401, brief(goneErrand));
    }

    /* ---------- 9.9 收藏链路 ---------- */
    // 此前只断言过「收藏列表不含已删除商品」，收藏这个动作本身从未被测过。
    // 用自建测试商品来验（绝不碰用户真实商品），验完必须取消收藏，
    // 否则 favorites 集合会留一条指向测试商品的脏记录。
    if (createdProductId) {
      const favDone = await callFn(mini, 'product', { action: 'toggleFavorite', productId: createdProductId });
      const favRows1 = (dataOf(await callFn(mini, 'product', { action: 'myFavorites', pageSize: 50 })) || {}).list || [];
      const favHas1 = favRows1.some(x => x._id === createdProductId);
      record(
        '收藏：点一次后进入我的收藏',
        codeOf(favDone) === 0 && (dataOf(favDone) || {}).isFavorited === true && favHas1,
        `isFavorited=${JSON.stringify((dataOf(favDone) || {}).isFavorited)}，我的收藏里${favHas1 ? '有' : '没有'}它`
      );

      // 页面级断言：光验接口不够 —— 曾经的真实缺陷是「接口有数据，页面却是空的」
      // （favorites.js 只有 onShow，且用 `if (this.loaded)` 守卫，首次进入
      //   this.loaded 为 undefined → 永远不加载 → 用户以为收藏没生效）。
      if (favHas1) {
        await mini.reLaunch('/pages/favorites/favorites');
        await sleep(2600);
        // 读页面数据要轮询（异步数据读太早会假失败）
        let favPageLen = 0;
        for (let i = 0; i < 6; i++) {
          favPageLen = await mini
            .evaluate(() => {
              const ps = getCurrentPages();
              const p = ps[ps.length - 1];
              return ((p.data || {}).list || []).length;
            })
            .catch(() => -1);
          if (favPageLen > 0) break;
          await sleep(800);
        }
        record(
          '收藏：首屏进入「我的收藏」能渲染出已收藏的商品',
          favPageLen >= 1,
          `页面 list 长度 ${favPageLen}`
        );
      }

      const favUndone = await callFn(mini, 'product', { action: 'toggleFavorite', productId: createdProductId });
      const favRows2 = (dataOf(await callFn(mini, 'product', { action: 'myFavorites', pageSize: 50 })) || {}).list || [];
      const favHas2 = favRows2.some(x => x._id === createdProductId);
      record(
        '收藏：再点一次取消，移出我的收藏',
        codeOf(favUndone) === 0 && (dataOf(favUndone) || {}).isFavorited === false && !favHas2,
        `isFavorited=${JSON.stringify((dataOf(favUndone) || {}).isFavorited)}，我的收藏里${favHas2 ? '仍有' : '已无'}它`
      );
    }

    /* ---------- 9.95 收藏统计口径 ---------- */
    // 真实缺陷（2026-09-18，用户报「收藏显示 1 点进去却什么都没有」）：
    // 「我的」页的收藏数直接 count favorites 记录条数，而「我的收藏」列表会过滤掉
    // 商品已删除/不存在的条目 → 数字比列表多。这里主动造出这个场景来守住它。
    {
      const pubTmp = await callFn(mini, 'product', {
        action: 'publish',
        title: '[自动化测试] 收藏口径核对',
        desc: '验证收藏数字与列表口径一致，结束即删',
        price: 1.5,
        images: ['cloud://e2e-test/placeholder.png'],
        categoryId: 'book',
        categoryName: '教材书籍',
        tradePlace: '图书馆门口'
      });
      const tmpId = (dataOf(pubTmp) || {}).productId;

      if (tmpId) {
        const c0 = (((dataOf(await callFn(mini, 'user', { action: 'getProfile' })) || {}).stats) || {}).favCount || 0;

        await callFn(mini, 'product', { action: 'toggleFavorite', productId: tmpId });
        const c1 = (((dataOf(await callFn(mini, 'user', { action: 'getProfile' })) || {}).stats) || {}).favCount || 0;

        // 软删商品：favorites 里那条记录还在，但已经「失效」（商品查不到了）
        await callFn(mini, 'product', { action: 'remove', productId: tmpId });

        const c2 = (((dataOf(await callFn(mini, 'user', { action: 'getProfile' })) || {}).stats) || {}).favCount || 0;
        const listAfter = (dataOf(await callFn(mini, 'product', { action: 'myFavorites', pageSize: 50 })) || {}).list || [];

        record(
          '收藏：商品被删除后收藏数不虚高（与列表口径一致）',
          c1 === c0 + 1 && c2 === c0 && (c2 >= 50 || listAfter.length === c2),
          `收藏前 ${c0} → 收藏后 ${c1} → 商品删除后 ${c2}；列表 ${listAfter.length} 条`
        );
      } else {
        record('收藏：商品被删除后收藏数不虚高（与列表口径一致）', false, '临时商品创建失败：' + brief(pubTmp));
      }
    }

    /* ---------- 9.96 面交地点：自由填写（2026-09-18 起不再有预设选项） ---------- */
    // 用户要求：面交地点不做选项，由卖家自己打字描述。
    // 走真实链路验三件事：自定义描述能原样存下并回显、纯空格算没填、超长被拦。
    {
      // 故意用一句「预设选项里绝不会有」的描述，证明没有白名单在背后卡值
      const PLACE_TEXT = '北门快递驿站旁的大树下（3 栋对面）';
      const pubPlace = await callFn(mini, 'product', {
        action: 'publish',
        title: '[自动化测试] 面交地点自由填写',
        desc: '验证面交地点支持用户自己打字描述，结束即删',
        price: 2.5,
        images: ['cloud://e2e-test/placeholder.png'],
        categoryId: 'book',
        categoryName: '教材书籍',
        tradePlace: PLACE_TEXT
      });
      const placeId = (dataOf(pubPlace) || {}).productId;

      if (placeId) {
        const det = await callFn(mini, 'product', { action: 'detail', productId: placeId });
        // 注意 detail 的 data 是 { product, seller, isFavorited, isOwner }，
        // 字段在 data.product 下（第一次就写成 data.tradePlace，读到 undefined 假失败）
        const got = (((dataOf(det) || {}).product) || {}).tradePlace;

        // 列表卡片 📍 用的是同一个字段，一并确认带得出来
        const lst = await callFn(mini, 'product', { action: 'myList', status: 'on_sale', pageSize: 20 });
        const row = ((dataOf(lst) || {}).list || []).find(r => r._id === placeId);

        record(
          '面交地点：自定义描述原样保存并回显',
          got === PLACE_TEXT && (!row || row.tradePlace === PLACE_TEXT),
          `写入「${PLACE_TEXT}」→ 详情读出「${got}」${row ? '；列表「' + row.tradePlace + '」' : ''}`
        );

        await callFn(mini, 'product', { action: 'remove', productId: placeId });
      } else {
        record('面交地点：自定义描述原样保存并回显', false, '临时商品创建失败：' + brief(pubPlace));
      }

      // 纯空格等于没填（前端会 trim，云函数也要兜住 —— 它可以被直接调用）
      const blank = await callFn(mini, 'product', {
        action: 'publish',
        title: '[自动化测试] 空面交地点',
        desc: '空面交地点必须被拒绝，不应落库',
        price: 1,
        images: ['cloud://e2e-test/placeholder.png'],
        categoryId: 'book',
        categoryName: '教材书籍',
        tradePlace: '   '
      });
      record(
        '面交地点：纯空格视为未填写（拒绝发布）',
        codeOf(blank) !== 0,
        codeOf(blank) !== 0 ? `已拒绝（code=${codeOf(blank)}）` : '空白地点竟然发布成功了'
      );
      // 万一真发出来了（断言失败），立刻清掉，别留垃圾
      const blankId = (dataOf(blank) || {}).productId;
      if (blankId) await callFn(mini, 'product', { action: 'remove', productId: blankId });

      // 超长地点会把详情页排版撑破（前端 maxlength=30，云函数对齐同一上限）
      const tooLong = await callFn(mini, 'product', {
        action: 'publish',
        title: '[自动化测试] 超长面交地点',
        desc: '超长面交地点必须被拒绝，不应落库',
        price: 1,
        images: ['cloud://e2e-test/placeholder.png'],
        categoryId: 'book',
        categoryName: '教材书籍',
        tradePlace: '很长'.repeat(20)
      });
      record(
        '面交地点：超过 30 字被拒绝',
        codeOf(tooLong) !== 0,
        codeOf(tooLong) !== 0 ? `已拒绝（code=${codeOf(tooLong)}）` : '超长地点竟然发布成功了'
      );
      const longId = (dataOf(tooLong) || {}).productId;
      if (longId) await callFn(mini, 'product', { action: 'remove', productId: longId });
    }

    /* ---------- 10. 清理测试数据 ---------- */
    if (createdProductId) {
      const rm = await callFn(mini, 'product', { action: 'remove', productId: createdProductId });
      record('清理测试商品', codeOf(rm) === 0, brief(rm));
    }
    // 兜底清理：历史上遗留的测试商品也一并清掉，保证反复跑不会越积越多。
    // 只删标题带测试标记的，绝不碰真实数据。
    const allMine = await callFn(mini, 'product', { action: 'myList', pageSize: 50 });
    const junkRows = ((dataOf(allMine) || {}).list || []).filter(r => /自动化测试/.test(r.title || ''));
    let swept = 0;
    for (const r of junkRows) {
      const rm = await callFn(mini, 'product', { action: 'remove', productId: r._id });
      if (codeOf(rm) === 0) swept++;
    }
    if (swept) record('清理遗留测试商品', true, `删除 ${swept} 条`);

    const left = await callFn(mini, 'product', { action: 'myList', pageSize: 50 });
    const leftRows = (dataOf(left) || {}).list || [];
    const leftTitles = leftRows.map(r => r.title).join(' | ');

    // 跑腿任务**不在** myList 里（两类内容分开查），所以兜底清理要单独做一遍，
    // 否则跑腿测试数据会一直积在库里，谁也发现不了。
    const allErrands = await callFn(mini, 'product', { action: 'errandMyList', role: 'publisher' });
    for (const r of (((dataOf(allErrands) || {}).list) || []).filter(x => /自动化测试/.test(x.title || ''))) {
      await callFn(mini, 'product', { action: 'remove', productId: r._id });
    }
    const leftErrand = await callFn(mini, 'product', { action: 'errandMyList', role: 'publisher' });
    const leftErrandRows = (dataOf(leftErrand) || {}).list || [];
    const leftErrandTitles = leftErrandRows.map(r => r.title).join(' | ');

    record(
      '确认无测试残留',
      !leftRows.some(r => /自动化测试/.test(r.title || '')) &&
        !leftErrandRows.some(r => /自动化测试/.test(r.title || '')),
      leftRows.length || leftErrandRows.length
        ? `我的发布 ${leftRows.length} 条：${leftTitles}｜我的跑腿 ${leftErrandRows.length} 条：${leftErrandTitles}`
        : '我的发布 0 条、我的跑腿 0 条'
    );

    // 收藏列表里不允许出现「已删除」的卡片：
    // 那种卡片点进去只会得到 404，而且没有任何入口能把它从收藏里清掉。
    const favNow = await callFn(mini, 'product', { action: 'myFavorites', pageSize: 50 });
    const favRows = (dataOf(favNow) || {}).list || [];
    record(
      '收藏列表不含已删除商品',
      codeOf(favNow) === 0 && !favRows.some(r => r.status === 'deleted'),
      codeOf(favNow) === 0
        ? `收藏 ${favRows.length} 条，其中已删除 ${favRows.filter(r => r.status === 'deleted').length} 条`
        : brief(favNow)
    );

    // 复核收藏残留必须**直接查 favorites 集合**。
    // myFavorites 接口会把「商品已删除」的条目过滤掉，拿它做残留复核永远是
    // 「无残留」（假阴性）—— 2026-09-18 正是因此留下了一条指向已删测试商品的
    // 脏记录：用户看到「收藏 1」，点进去却什么都没有。
    // 上面的 myFavorites 调用会触发服务端自愈清理（异步），所以这里轮询等它生效。
    let favDb = null;
    for (let i = 0; i < 8; i++) {
      await mini.evaluate(() => {
        globalThis.__FC = { done: false };
        wx.cloud
          .database()
          .collection('favorites')
          .count()
          .then(r => { globalThis.__FC = { done: true, ok: true, total: r.total }; })
          .catch(e => { globalThis.__FC = { done: true, ok: false, err: (e && (e.errMsg || e.message)) || String(e) }; });
      });
      for (let j = 0; j < 8; j++) {
        await sleep(300);
        const r = await mini.evaluate(() => globalThis.__FC);
        if (r && r.done) { favDb = r; break; }
      }
      if (favDb && favDb.ok && (favRows.length >= 50 || favDb.total === favRows.length)) break;
      await sleep(500);
    }
    record(
      '收藏：库中记录数与列表条数一致（无失效残留）',
      !!(favDb && favDb.ok) && (favRows.length >= 50 || favDb.total === favRows.length),
      favDb && favDb.ok
        ? `库中 ${favDb.total} 条，列表 ${favRows.length} 条`
        : `查库失败：${(favDb && favDb.err) || 'timeout'}`
    );

    // 铁律复核：用户的真实商品必须与开测前状态完全一致（一条都不能被改）
    const finalList = await callFn(mini, 'product', { action: 'myList', pageSize: 50 });
    const finalRows = (dataOf(finalList) || {}).list || [];
    const changed = [];
    for (const id of Object.keys(realProducts)) {
      const row = finalRows.find(r => r._id === id);
      if (!row) changed.push(`${realProducts[id]} → 已消失`);
      else if (row.title + ' / ' + row.status !== realProducts[id]) {
        changed.push(`${row.title}: ${realProducts[id].split(' / ')[1]} → ${row.status}`);
      }
    }
    record(
      '用户真实商品状态未被测试改动',
      changed.length === 0,
      changed.length ? changed.join('；') : `${Object.keys(realProducts).length} 条真实商品状态不变`
    );

    if (tempVerified && testUserId) {
      const rv = await callFn(mini, 'admin', { action: 'resetVerify', targetUserId: testUserId });
      const after = await callFn(mini, 'user', { action: 'getProfile' });
      const nowStatus = ((dataOf(after) || {}).userInfo || {}).verifyStatus;
      record('复位认证状态', codeOf(rv) === 0 && nowStatus === 'none', `verifyStatus → ${nowStatus}`);
    }


    // 还原测试期间改动的头像昵称
    if (profileTouched) {
      // 先读当前库里的头像：如果它既不是「测试开始前的」也不是「本次测试上传的」，
      // 说明测试期间用户自己改过资料 —— 这时**不还原头像**（尊重用户的最新操作），只还原昵称。
      const curNow = await callFn(mini, 'user', { action: 'getProfile' });
      const curAvatar = ((dataOf(curNow) || {}).userInfo || {}).avatarUrl || '';
      const avatarExternallyChanged =
        curAvatar && curAvatar !== (origUser.avatarUrl || '') && curAvatar !== savedAvatarFileID;
      const restore = await callFn(mini, 'user', {
        action: 'login',
        nickName: origUser.nickName || '微信用户',
        avatarUrl: avatarExternallyChanged ? curAvatar : (origUser.avatarUrl || '')
      });
      if (avatarExternallyChanged) {
        console.log('   ⚠️ 测试期间头像被外部改动，跳过头像还原（保留用户最新头像）');
      }
      const back = await callFn(mini, 'user', { action: 'getProfile' });
      const bu = (dataOf(back) || {}).userInfo || {};
      const want = origUser.nickName || '微信用户';
      record('还原头像昵称', codeOf(restore) === 0 && bu.nickName === want, `nickName → ${bu.nickName}`);
    }

    // 删掉测试上传的图片，别在云存储里留垃圾
    const junkFiles = [avatarFileID, savedAvatarFileID].filter(Boolean);
    if (junkFiles.length) {
      const del = await callFn(mini, 'upload', { action: 'deleteFiles', fileIDs: junkFiles });
      record('清理云存储测试文件', codeOf(del) === 0, brief(del));
    }

    /* ---------- 汇总 ---------- */
    console.log('\n──────── 结果汇总 ────────');
    const failed = results.filter(r => !r.ok);
    console.log(`通过 ${results.length - failed.length}/${results.length}`);
    if (failed.length) failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`));
    if (jsErrors.length) {
      console.log(`\n捕获到 ${jsErrors.length} 条小程序运行时错误：`);
      jsErrors.slice(0, 12).forEach(e => console.log('  ' + e));
    } else {
      console.log('未捕获到小程序运行时错误');
    }
    await mini.disconnect();
    process.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.error('测试中断:', (e && e.message) || e);
    try { if (mini) await mini.disconnect(); } catch (_) {}
    process.exit(2);
  }
})();
