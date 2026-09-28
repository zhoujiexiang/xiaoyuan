// app.js
const config = require('./config');

// 「已主动退出登录」的本地标记。用 storage 而不是只用内存，
// 否则杀掉小程序再进来，ensureLogin() 又会把用户静默登回去。
const LOGGED_OUT_KEY = 'loggedOut';

/** 造一个「未登录」业务错误，页面 catch 后按未登录态渲染 */
function makeNotLoginError(msg) {
  const err = new Error(msg || '请先登录');
  err.code = 40101;
  return err;
}

App({
  globalData: {
    userInfo: null,
    openid: null,
    envId: config.envId,
    school: config.school,
    systemInfo: null,
    // 列表页需要重新拉取的标记，见 markListRefresh()
    listNeedsRefresh: false,
    // 用户是否主动点了「退出登录」。
    // 注意：小程序没法真正「注销」——openid 是微信下发的，退出再登录还是同一个人。
    // 所以这里做的是「退出当前账号的本地登录态」：不自动恢复登录，
    // 需要用户自己再点一次登录。见 logout() / ensureLogin()。
    loggedOut: false
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }

    if (!config.envId || config.envId === 'your-env-id') {
      // 环境 ID 没填是最常见的白屏原因，直接给出明确提示
      console.error(
        '[配置错误] 请打开 miniprogram/config.js，把 envId 改成你的云开发环境 ID。\n' +
        '获取方式：微信开发者工具 → 云开发 → 设置 → 环境 ID'
      );
      wx.showModal({
        title: '还没配置云环境',
        content: '请打开 miniprogram/config.js，把 envId 改成你的云开发环境 ID。',
        showCancel: false
      });
      return;
    }

    wx.cloud.init({
      env: config.envId,
      traceUser: true
    });

    // 缓存系统信息，避免各页面重复获取
    try {
      this.globalData.systemInfo = wx.getWindowInfo
        ? { ...wx.getWindowInfo(), ...wx.getDeviceInfo() }
        : wx.getSystemInfoSync();
    } catch (e) {
      console.warn('获取系统信息失败', e);
    }

    // 恢复本地缓存的用户信息（先渲染，再静默刷新）
    const cached = wx.getStorageSync('userInfo');
    if (cached) this.globalData.userInfo = cached;

    // 上次是主动退出登录的：不要用缓存里的资料假装已登录
    this.globalData.loggedOut = !!wx.getStorageSync(LOGGED_OUT_KEY);
    if (this.globalData.loggedOut) this.globalData.userInfo = null;

    // 首次启动自动尝试初始化数据库（幂等）。
    // 之所以不靠按钮：数据库没建时登录必然失败，而登录失败会把
    // 初始化入口挡住，形成死锁。这里直接兜底。
    if (!wx.getStorageSync('dbInited')) {
      this.autoInitDb();
    }
  },

  /**
   * 静默初始化数据库。成功则打标记，之后不再重复调用。
   * 失败不弹窗打扰用户（真要用的时候对应功能会给出明确报错）。
   */
  async autoInitDb() {
    try {
      const { call } = require('./utils/request');
      const data = await call('init', '', {}, { silent: true });

      const s = (data && data.summary) || {};
      console.log('[app] 自动初始化完成:', JSON.stringify(s));

      if ((s.failedCount || 0) === 0) {
        wx.setStorageSync('dbInited', 1);
      } else {
        console.warn('[app] 自动初始化有失败项，详见下方日志');
        console.warn(JSON.stringify((data && data.collections) || [], null, 2));
      }
    } catch (e) {
      // 不要在这里弹窗：用户可能只是想浏览，
      // 真正的功能被调用时会给出更精准的错误提示
      console.error('[app] 自动初始化失败（不影响浏览，用到相关功能时会再提示）:', e);
    }
  },

  /**
   * 确保已登录。页面里统一用这个，不要各写各的。
   * 注意：这里只做「已注册用户的信息刷新」，不负责首次注册的授权引导。
   * 首次登录必须由用户在登录页主动点击（微信要求授权要用户手势触发）。
   *
   * 用户主动退出登录后（loggedOut=true）这里会直接抛错，不再静默注册回去——
   * 否则「退出登录」这个按钮点了等于没点：下一次进页面又被自动登上了。
   * @returns {Promise<object>} userInfo
   */
  async ensureLogin() {
    // 主动退出过：保持未登录，直到用户自己去登录页点一次登录
    if (this.globalData.loggedOut) {
      throw makeNotLoginError('已退出登录，请重新登录');
    }

    if (this.globalData.userInfo) return this.globalData.userInfo;

    const { call } = require('./utils/request');

    // 本地有缓存直接复用，避免每次都打云函数
    const cached = wx.getStorageSync('userInfo');
    if (cached && cached._id) {
      this.globalData.userInfo = cached;
      return cached;
    }

    // 没有缓存：走一次静默注册/登录（用默认资料，不弹授权框）
    const userInfo = await call('user', 'login', {
      nickName: '',
      avatarUrl: '',
      // 学校名从配置读，保证全校一致
      schoolId: config.school,
      schoolName: config.school
    });

    this.globalData.userInfo = userInfo;
    wx.setStorageSync('userInfo', userInfo);
    return userInfo;
  },

  /** 登录态失效时清空（服务端返回 401 时由 request.js 调用） */
  clearLogin() {
    this.globalData.userInfo = null;
    this.globalData.openid = null;
    wx.removeStorageSync('userInfo');
  },

  /* ---------- 退出登录 ----------
   * 先想清楚「退出登录」在小程序里到底能做什么：
   *   - 做不到：解绑微信账号。openid 由微信下发，退出后再进来还是同一个 openid，
   *     同一个账号。所以别把它宣传成「注销账号」。
   *   - 做得到：清掉本地登录态，并且在用户主动登录之前不再自动登录。
   *     实际效果是「换手机/借给别人看时，我的资料和消息不会被直接看到」。
   * 真要注销账号（删数据）是另一件事，要单独做接口，这里不做。
   */

  /** 设置「已主动退出」标记并落盘 */
  setLoggedOut(flag) {
    this.globalData.loggedOut = !!flag;
    if (flag) wx.setStorageSync(LOGGED_OUT_KEY, 1);
    else wx.removeStorageSync(LOGGED_OUT_KEY);
  },

  /**
   * 退出登录：清本地登录态 + 回登录页。
   * 确认弹窗由调用方（「我的」页面）负责，这里只管执行。
   */
  logout() {
    this.setLoggedOut(true);
    this.clearLogin();
    // 用 reLaunch 而不是 navigateTo：把整个页面栈清掉，
    // 否则用户按返回还能回到「我的」等已登录页面，看着像没退成功。
    wx.reLaunch({ url: '/pages/login/login' });
  },

  /** 判断是否已认证 */
  isVerified() {
    const u = this.globalData.userInfo;
    return !!u && u.verifyStatus === 'passed';
  },

  /* ---------- 列表刷新标记 ----------
   * 为什么不用 getCurrentPages() 去拿首页实例再调它的方法：
   * tabBar 页面切换之后，getCurrentPages() **只返回当前这一个页面**
   * （实测：在发布页里拿到的是 ["pages/publish/publish"]），
   * 所以在发布页里 `pages.find(p => p.route === 'pages/index/index')`
   * 永远是 undefined，标记刷新是个静默的空操作。
   * 后果：发布成功后回到首页，列表还是旧的，用户点到旧卡片就会看到
   * 「商品不存在或已被删除」。
   *
   * 改成全局标记 + 列表页自己在 onShow 里消费，不依赖页面栈。
   */
  markListRefresh() {
    this.globalData.listNeedsRefresh = true;
  },

  /**
   * 只看标记、不消费。
   * 列表页必须先 peek、等「确实要发起刷新」时再 consume——
   * 否则在「正在加载中」的早退分支上标记会被白白吃掉，
   * 结果就是标记丢了、列表没刷新，用户又点到失效卡片。
   */
  hasListRefresh() {
    return !!this.globalData.listNeedsRefresh;
  },

  /** 取出并清除刷新标记（一次性消费） */
  consumeListRefresh() {
    if (this.globalData.listNeedsRefresh) {
      this.globalData.listNeedsRefresh = false;
      return true;
    }
    return false;
  },

  /* ---------- 全局异常兜底 ----------
   * 没有这两个钩子时，线上报错只会出现在用户手机上，你在后台什么都看不到。
   * 挂上之后至少能在「微信开发者工具 → 调试器」和
   * 小程序后台「运维中心 → 异常」里看到线索（后台只统计，不带日志，日志要靠自己上报）。
   */
  onError(err) {
    // 只经由 reportError 打一次日志：那里统一过滤已知噪声，
    // 否则同一条错误会在 console 里出现两遍，干扰排查。
    this.reportError('onError', err);
  },

  onUnhandledRejection(res) {
    this.reportError('onUnhandledRejection', res && res.reason);
  },

  /** 页面不存在时兜底回首页，避免用户卡在空白页 */
  onPageNotFound(res) {
    console.warn('[App.onPageNotFound]', res && res.path);
    wx.reLaunch({ url: '/pages/index/index' });
  },

  /**
   * 错误上报。默认只打日志（不引入第三方监控）。
   * 想接监控的话，把这里换成 wx.cloud.callFunction({ name: 'reportError' }) 即可。
   */
  reportError(type, err) {
    try {
      const msg = (err && (err.stack || err.message || err.errMsg || err)) || '';
      const text = String(msg);

      // 已知噪声，直接丢弃：开发者工具冷启动时会用 wx://not-found 这个
      // 框架内部伪协议探测组件，必然报「Component is not found in path
      // "wx://not-found"」。它只出现在调试器，体验版/正式版没有，
      // 项目里也不存在这个路径。不滤掉会把真实错误淹没。
      if (text.indexOf('wx://not-found') >= 0) return;

      console.error(`[error-report] ${type}:`, text.slice(0, 500));
    } catch (e) {
      // 上报本身失败不能影响主流程
    }
  }
});
