// pages/userProfile/userProfile.js — 别人的主页（点头像进来）
const { call } = require('../../utils/request');
const { formatPrice, formatTime, toast } = require('../../utils/util');
const { VERIFY_STATUS_TEXT } = require('../../utils/constants');

Page({
  data: {
    userId: '',
    userInfo: null,
    isSelf: false,
    banned: false,
    products: [],

    verifyText: '',
    verifyClass: '',
    joinText: '',

    loading: true,
    notFound: false,
    loadError: ''
  },

  onLoad(options) {
    const raw = options && options.userId;
    // 和详情页同样的防御：任何入口把 undefined / null 拼进 URL 时，
    // 不要白跑一次云端，直接按「用户不存在」展示。
    const userId =
      raw && raw !== 'undefined' && raw !== 'null' ? String(raw).trim() : '';

    if (!userId) {
      console.warn('[userProfile] 非法的 userId，已拦截：' + JSON.stringify(raw));
      this.setData({ loading: false, notFound: true });
      return;
    }

    this.setData({ userId });
    this.loadProfile();
  },

  async loadProfile() {
    this.setData({ loading: true, notFound: false, loadError: '' });

    try {
      const res = await call('user', 'getPublicProfile', { userId: this.data.userId });

      const userInfo = res.userInfo || {};
      const products = (res.products || []).map(p => ({
        ...p,
        priceText: formatPrice(p.price),
        timeText: formatTime(p.createdAt)
      }));

      this.setData({
        userInfo,
        isSelf: !!res.isSelf,
        banned: !!res.banned,
        products,
        verifyText: VERIFY_STATUS_TEXT[userInfo.verifyStatus] || '',
        verifyClass: this.getVerifyClass(userInfo.verifyStatus),
        joinText: formatTime(userInfo.createdAt),
        loading: false
      });

      wx.setNavigationBarTitle({ title: userInfo.nickName || '同学的主页' });
    } catch (e) {
      const code = e && e.code;
      this.setData({
        loading: false,
        notFound: code === 40401,
        // 网络/服务异常要和「用户不存在」分开，否则排查时全瞎
        loadError: code === 40401 ? '' : ((e && (e.msg || e.message)) || '加载失败，请稍后重试')
      });
    }
  },

  retry() {
    this.loadProfile();
  },

  getVerifyClass(status) {
    if (status === 'passed') return 'tag-green';
    if (status === 'pending') return 'tag-orange';
    if (status === 'rejected') return 'tag-red';
    return 'tag-gray';
  },

  /* ---------- 私聊 ---------- */

  /**
   * 发消息
   *
   * 不带 productId —— 这是「用户对用户」的私聊会话，
   * 与「从某个商品详情点联系卖家」产生的会话是两条（后者带商品上下文）。
   * conversationId 由服务端按「两个 openid 排序 + 商品 ID」算出，客户端不参与，
   * 避免被伪造。
   */
  async onChat() {
    if (!this.data.userInfo) return;

    if (this.data.isSelf) return toast('这是你自己呀');

    if (this.data.banned) return toast('该账号已被封禁，无法联系');

    const app = getApp();
    try {
      await app.ensureLogin();
    } catch (e) {
      return wx.navigateTo({ url: '/pages/login/login' });
    }

    const u = this.data.userInfo;
    wx.navigateTo({
      url: `/pages/chat/chat?toId=${u._id}&toName=${encodeURIComponent(u.nickName || '同学')}&toAvatar=${encodeURIComponent(u.avatarUrl || '')}`
    });
  },

  /* ---------- 商品 ---------- */

  onCardTap(e) {
    const id = e.detail && e.detail.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  goBack() {
    wx.navigateBack();
  }
});
