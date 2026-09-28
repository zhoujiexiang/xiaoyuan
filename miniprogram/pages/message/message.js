// pages/message/message.js — 会话列表
const { call } = require('../../utils/request');
const { formatChatTime, toast } = require('../../utils/util');

Page({
  data: {
    list: [],
    loading: true,
    needLogin: false,
    // 因为要显示未读数，需要在 onShow 里刷新
    lastLoadTime: 0
  },

  onShow() {
    this.init();
  },

  async init() {
    const app = getApp();
    try {
      await app.ensureLogin();
      this.setData({ needLogin: false });
      this.loadConversations();
    } catch (e) {
      this.setData({ needLogin: true, loading: false });
    }
  },

  async loadConversations() {
    try {
      const res = await call('message', 'listConversations', {}, { silent: true });
      const list = (res.list || []).map(item => ({
        ...item,
        timeText: formatChatTime(item.lastMessage && item.lastMessage.createdAt)
      }));
      this.setData({ list, loading: false });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  onPullDownRefresh() {
    this.loadConversations().then(() => wx.stopPullDownRefresh());
  },

  onConversationTap(e) {
    const { conversationId, peerId, peerName, peerAvatar, productId, productTitle } =
      e.currentTarget.dataset;

    wx.navigateTo({
      url: `/pages/chat/chat?conversationId=${conversationId}&toId=${peerId}&toName=${encodeURIComponent(peerName)}&toAvatar=${encodeURIComponent(peerAvatar)}&productId=${productId}&productTitle=${encodeURIComponent(productTitle || '')}`
    });
  },

  /** 点会话头像 → 对方主页 */
  onAvatarTap(e) {
    const peerId = e.currentTarget.dataset.peerId;
    if (!peerId) return;
    wx.navigateTo({ url: `/pages/userProfile/userProfile?userId=${peerId}` });
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
