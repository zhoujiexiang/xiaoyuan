// pages/mine/mine.js
const config = require('../../config');
const { call } = require('../../utils/request');
const { VERIFY_STATUS_TEXT } = require('../../utils/constants');
const { toast } = require('../../utils/util');

Page({
  data: {
    userInfo: null,
    stats: { onSale: 0, sold: 0, favCount: 0 },
    verifyText: '',
    verifyClass: '',
    isAdmin: false,
    pendingCount: 0,
    loading: true,
    needLogin: false,
    loginError: '',
    // 「初始化数据库」是开发期工具，**只允许开发版显示**。
    // ⚠️ 不能用 `envVersion !== 'release'`：体验版（trial）是发给真实同学用的，
    // 让他们看到一个 🗄️「初始化数据库」按钮既没用又吓人（2026-09-28 收紧为仅 develop）。
    // 仍然是按运行环境自动判断，不会出现「忘了关调试入口」这种事。
    showDebugTools: false
  },

  onLoad() {
    let envVersion = 'release';
    try {
      envVersion = wx.getAccountInfoSync().miniProgram.envVersion || 'release';
    } catch (e) {
      // 个别基础库/环境取不到，按正式版处理（宁可少显示，不可多显示）
      envVersion = 'release';
    }
    this.setData({ showDebugTools: envVersion === 'develop' });
  },

  onShow() {
    this.loadProfile();
    this.checkAdmin();
  },

  /** 判断是否管理员，并取待处理数量用于红点 */
  async checkAdmin() {
    try {
      const res = await call('admin', 'checkAdmin', {}, { silent: true });
      if (!res.isAdmin) {
        return this.setData({ isAdmin: false, pendingCount: 0 });
      }

      // 是管理员，顺便取待处理数量
      const stats = await call('admin', 'stats', {}, { silent: true });
      this.setData({
        isAdmin: true,
        pendingCount: (stats.pendingVerify || 0) + (stats.pendingReports || 0)
      });
    } catch (e) {
      // 非管理员会被拒，静默处理
      this.setData({ isAdmin: false, pendingCount: 0 });
    }
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  },

  async loadProfile() {
    const app = getApp();
    try {
      await app.ensureLogin();
      this.setData({ needLogin: false });

      const res = await call('user', 'getProfile', {}, { silent: true });
      const userInfo = res.userInfo || {};

      this.setData({
        userInfo,
        stats: res.stats || { onSale: 0, sold: 0, favCount: 0 },
        verifyText: VERIFY_STATUS_TEXT[userInfo.verifyStatus] || '',
        verifyClass: this.getVerifyClass(userInfo.verifyStatus),
        loading: false,
        loginError: ''
      });

      app.globalData.userInfo = { ...app.globalData.userInfo, ...userInfo };
      wx.setStorageSync('userInfo', app.globalData.userInfo);
    } catch (e) {
      // 把真实原因显示出来。否则用户只看到一个锁，不知道是没登录、
      // 没初始化数据库、还是云函数没部署 —— 这三种情况处理方式完全不同。
      this.setData({
        needLogin: true,
        loading: false,
        loginError: (e && (e.msg || e.message)) || '登录状态异常'
      });
    }
  },

  getVerifyClass(status) {
    if (status === 'passed') return 'tag-green';
    if (status === 'pending') return 'tag-orange';
    if (status === 'rejected') return 'tag-red';
    return 'tag-gray';
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  /** 去「编辑资料」页补全头像昵称 */
  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  goVerify() {
    const status = this.data.userInfo && this.data.userInfo.verifyStatus;
    if (status === 'passed') {
      return toast('你已完成校园认证');
    }
    wx.navigateTo({ url: '/pages/verify/verify' });
  },

  goMyProducts(e) {
    const status = e.currentTarget.dataset.status || '';
    wx.navigateTo({ url: `/pages/myProducts/myProducts?status=${status}` });
  },

  goMyOrders(e) {
    const role = e.currentTarget.dataset.role || 'buyer';
    wx.navigateTo({ url: `/pages/myOrders/myOrders?role=${role}` });
  },

  goFavorites() {
    wx.navigateTo({ url: '/pages/favorites/favorites' });
  },

  goMyErrands() {
    wx.navigateTo({ url: '/pages/myErrands/myErrands' });
  },

  onAbout() {
    wx.showModal({
      title: '关于校园二手',
      content: '一个面向校园的闲置交易平台，支持同校交易、面交验货。\n\n交易请在公共场所进行，注意人身与财产安全。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  onFeedback() {
    const c = config.contact || {};
    const lines = [];
    if (c.wechat) lines.push('微信：' + c.wechat);
    if (c.qq) lines.push('QQ：' + c.qq);
    if (c.email) lines.push('邮箱：' + c.email);

    wx.showModal({
      title: '意见反馈',
      content: lines.length
        ? '遇到问题或有建议，欢迎联系管理员：\n\n' + lines.join('\n')
        : '遇到问题或有建议，请通过小程序客服反馈。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  /**
   * 退出登录
   *
   * 先说清楚它能做什么：小程序**没有办法解绑微信账号**（openid 是微信下发的，
   * 退出后再进来还是同一个人、同一个账号），所以这里不是「注销账号」。
   * 实际做的是：清掉本机登录态，并且在用户主动登录之前不再自动登录。
   * 对话框文案也照这个口径写，避免用户以为退出就把账号删了。
   */
  async onLogout() {
    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: '退出登录',
        content:
          '退出后将清除本机登录状态，需要重新点击登录才能发布、下单、聊天。\n\n' +
          '你的账号和已发布的内容不会被删除。',
        confirmText: '退出登录',
        confirmColor: '#fa5151',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;

    const app = getApp();
    if (app && typeof app.logout === 'function') {
      app.logout();
    } else {
      // 理论上不会走到这里，兜个底免得用户点了没反应
      app.clearLogin();
      wx.reLaunch({ url: '/pages/login/login' });
    }
  },

  /**
   * 一键初始化数据库（开发期用）
   * 调用 init 云函数创建 6 个集合，幂等，可重复执行
   */
  onInitDb() {
    console.log('[init] 按钮已触发');

    wx.showModal({
      title: '初始化数据库',
      content:
        '将自动创建 6 个数据集合（users / products / orders / messages / favorites / reports）。\n\n' +
        '已存在的集合会自动跳过，可放心重复执行。',
      confirmText: '开始',
      cancelText: '取消',
      success: res => {
        console.log('[init] 弹窗回调:', res);
        if (res.confirm) this.runInit();
      },
      fail: err => {
        console.error('[init] 弹窗失败:', err);
      }
    });
  },

  /** 真正执行初始化，逻辑独立出来方便复用和调试 */
  async runInit() {
    console.log('[init] 开始调用云函数');

    wx.showLoading({ title: '初始化中...', mask: true });

    try {
      const data = await call('init', '', {}, { silent: true });
      wx.hideLoading();

      console.log('[init] 云函数返回:', JSON.stringify(data, null, 2));

      const s = (data && data.summary) || {};
      const cols = (data && data.collections) || [];

      if (!cols.length) {
        return wx.showModal({
          title: '初始化异常',
          content:
            '云函数没有返回集合信息。\n\n原始返回：\n' +
            JSON.stringify(data).slice(0, 300),
          showCancel: false
        });
      }

      const lines = cols
        .map(c => {
          if (c.status === 'created') return `✅ 新建  ${c.name}`;
          if (c.status === 'exists') return `⏭️ 已存在  ${c.name}`;
          return `❌ 失败  ${c.name}${c.errCode ? ' [' + c.errCode + ']' : ''}`;
        })
        .join('\n');

      const failed = cols.filter(c => c.status === 'failed');
      let extra = '';
      if (failed.length > 0) {
        extra =
          '\n\n失败详情：\n' +
          failed.map(f => `${f.name}: ${f.errCode || ''} ${f.error || ''}`).join('\n');
      }
      if (data.probe && data.probe !== 'ok') {
        extra += '\n\n环境探测：' + data.probe;
      }

      wx.showModal({
        title: `结果：${s.created || 0} 新建 / ${s.existed || 0} 已存在 / ${s.failedCount || 0} 失败`,
        content: lines + extra,
        showCancel: false,
        confirmText: '知道了'
      });
    } catch (e) {
      wx.hideLoading();
      const msg = (e && (e.msg || e.errMsg || e.message)) || '未知错误';
      console.error('[init] 调用失败:', e);

      wx.showModal({
        title: '初始化失败',
        content: msg + '\n\n请查看 Console 面板的 [init] 日志',
        showCancel: false
      });
    }
  }
});
