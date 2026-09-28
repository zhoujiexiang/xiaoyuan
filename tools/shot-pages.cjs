/**
 * tools/shot-pages.cjs — 给关键页面批量截图，用来**肉眼核对排版与文案**
 *
 * 为什么需要它：自动化测试能证明「功能通」，证明不了「长得对」。
 * 本项目真实踩过两个只有肉眼才发现的坑：
 *   1. pages/index/index.wxml 混入非法 UTF-8，5 行中文变成乱码 —— 编译、运行、接口全不报错；
 *   2. 发布页的时间选择器显示的是字面量「前」而不是时间值。
 * 所以改完 UI 之后，跑一遍这个脚本看图，比盯着断言列表看有用。
 *
 * 前置（和 e2e 一样，自动化服务是一次性的）：
 *   ./cli.bat close --project <项目路径>
 *   ./cli.bat auto  --project <项目路径> --auto-port 9700
 *   等约 30 秒后再跑本脚本
 *
 * 用法：
 *   NODE_PATH=<node_modules> node tools/shot-pages.cjs [端口] [可选:自己的 userId]
 *
 * 产出：`.workbuddy/e2e-shots/10~16-*.png`
 */
const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

const WS_PORT = Number(process.argv[2] || 9700);
const MY_ID = process.argv[3] || '';
const WS = `ws://127.0.0.1:${WS_PORT}`;
const OUT = path.resolve(__dirname, '../.workbuddy/e2e-shots');

fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 等待页面数据异步拉取完再截，否则截到的是初始帧 */
async function settle(mini, ms = 2600) {
  await sleep(ms);
}

async function capture(mini, name) {
  const info = await mini.evaluate(() => {
    const ps = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const p = ps[ps.length - 1];
    return p ? { route: p.route } : { route: '(无页面)' };
  });
  await mini.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`OK  ${name}  ←  ${info.route}`);
}

/** 点第 index 个匹配节点（用于切 tab 之后再截图） */
async function tapNth(mini, selector, index) {
  try {
    const page = await mini.currentPage();
    if (!page) return false;
    const hosts = await page.$$(selector);
    if (!hosts || hosts.length <= index) {
      console.log(`!!  没找到 ${selector}[${index}]（共 ${hosts ? hosts.length : 0} 个）`);
      return false;
    }
    await hosts[index].tap();
    return true;
  } catch (e) {
    console.log(`!!  点击 ${selector}[${index}] 失败: ${e.message}`);
    return false;
  }
}

async function main() {
  const mini = await automator.connect({ wsEndpoint: WS });

  // 1. 首页 · 闲置
  await mini.reLaunch('/pages/index/index');
  await settle(mini);
  await capture(mini, '10-home-goods');

  // 2. 首页 · 跑腿（真实点 tab）
  if (await tapNth(mini, '.type-tab', 1)) await settle(mini);
  await capture(mini, '11-home-errand');

  // 3. 发布页 · 卖闲置
  await mini.reLaunch('/pages/publish/publish');
  await settle(mini);
  await capture(mini, '12-publish-goods');

  // 3b. 发布页下半屏（分类 / 面交地点 / 价格 / 提交）
  //     这一屏以前从没被截过，是覆盖盲区 —— 而「容器里的文字被换行顶下去」
  //     这类问题恰好只在下半屏才看得出来。滚下去再拍一张。
  await mini.pageScrollTo(2000);
  await settle(mini, 1400);
  await capture(mini, '12b-publish-bottom');
  await mini.pageScrollTo(0);
  await settle(mini, 1000);

  // 4. 发布页 · 发跑腿
  if (await tapNth(mini, '.mode-tab', 1)) await settle(mini);
  await capture(mini, '13-publish-errand');

  // 5. 用户主页（需要传 userId）
  if (MY_ID) {
    await mini.reLaunch(`/pages/userProfile/userProfile?userId=${MY_ID}`);
    await settle(mini);
    await capture(mini, '14-userProfile');
  }

  // 6. 我的跑腿
  await mini.reLaunch('/pages/myErrands/myErrands');
  await settle(mini);
  await capture(mini, '15-myErrands');

  // 7. 我的（确认退出登录入口在不在）
  await mini.reLaunch('/pages/mine/mine');
  await settle(mini);
  await capture(mini, '16-mine');

  await mini.disconnect();
  console.log(`\n截图已写入 ${OUT}`);
}

main().catch(e => {
  console.error('截图失败:', e.message);
  process.exit(1);
});
