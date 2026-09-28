// pages/login/login.js
const { call } = require('../../utils/request');
const { toast } = require('../../utils/util');
const config = require('../../config');

Page({
  data: {
    school: config.school,
    agreed: true,
    logging: false
  },

  /**
   * 微信一键登录
   *
   * 这里不再调 wx.getUserProfile：从 2022-10-25 起它只返回匿名数据
   * （灰色默认头像 + 昵称「微信用户」），已经拿不到真实头像昵称。
   *
   * 官方现在要求用「头像昵称填写能力」：
   *   <button open-type="chooseAvatar"> + <input type="nickname">
   * 放在 pages/profile 里，登录后引导用户去填。
   *
   * 拿不到昵称头像不该阻断登录——先进得来，再补资料。
   */
  async onLogin() {
    if (!this.data.agreed) {
      return toast('请先阅读并同意用户协议');
    }
    if (this.data.logging) return;

    this.doLogin({ nickName: '', avatarUrl: '' });
  },

  async doLogin(userInfo) {
    if (this.data.logging) return;
    this.setData({ logging: true });

    try {
      const user = await call('user', 'login', {
        nickName: userInfo.nickName || '',
        avatarUrl: userInfo.avatarUrl || '',
        // 学校从 config.js 统一读取，不让用户选，避免各人填法不一致导致同校过滤失效
        schoolId: config.school,
        schoolName: config.school
      });

      const app = getApp();
      app.globalData.userInfo = user;
      wx.setStorageSync('userInfo', user);
      // 用户主动登录成功 → 解除「已退出」标记，之后各页面才能正常静默恢复登录态。
      // 漏掉这一步的症状：登录成功了，但换个页面又被当成未登录踢回登录页。
      if (typeof app.setLoggedOut === 'function') app.setLoggedOut(false);

      wx.showToast({ title: '登录成功', icon: 'success' });

      // 昵称还是系统默认值 → 引导去补全资料
      // 用 redirectTo 而非 navigateTo：把登录页从页面栈里换掉，
      // 否则用户在「编辑资料」页保存后返回，会退回到已经登录过的登录页
      const needProfile = !user.nickName || user.nickName === '微信用户';

      setTimeout(() => {
        if (needProfile) {
          wx.redirectTo({ url: '/pages/profile/profile' });
          return;
        }

        const pages = getCurrentPages();
        if (pages.length > 1) {
          wx.navigateBack();
        } else {
          wx.switchTab({ url: '/pages/index/index' });
        }
      }, 800);
    } catch (e) {
      // 把真实原因透出来，别只说「登录失败」
      console.error('[login] 失败:', e);
      wx.showModal({
        title: '登录失败',
        content: (e && (e.msg || e.message)) || '未知错误',
        showCancel: false
      });
    } finally {
      this.setData({ logging: false });
    }
  },

  toggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  showAgreement() {
    wx.showModal({
      title: '用户协议',
      content:
        '1. 本平台仅面向本校在校学生提供闲置物品交易服务。\n' +
        '2. 请勿发布违禁物品、虚假信息或侵权内容。\n' +
        '3. 交易请在校内公共场所面交，验货后再付款。\n' +
        '4. 平台不对交易纠纷承担直接责任，但会协助处理。\n' +
        '5. 违规账号将被限制功能或封禁。',
      showCancel: false,
      confirmText: '我知道了'
    });
  },

  onSkip() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
