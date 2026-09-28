// pages/chat/chat.js — 聊天页（使用云开发实时监听 watch）
const { call } = require('../../utils/request');
const { formatChatTime, toast } = require('../../utils/util');

const PAGE_SIZE = 20;

Page({
  data: {
    conversationId: '',
    toId: '',
    toName: '',
    toAvatar: '',
    productId: '',
    productTitle: '',
    productCover: '',

    messages: [],
    inputValue: '',
    myOpenid: '',
    // 自己的头像。原来 wxml 里用了 {{myAvatar}} 但 data 里根本没这个字段，
    // 于是「我发的消息」旁边永远是空白头像，一直没人发现。
    myAvatar: '',
    loading: true,
    sending: false,
    scrollIntoView: ''
  },

  watcher: null,

  onLoad(options) {
    this.setData({
      conversationId: options.conversationId || '',
      toId: options.toId || '',
      toName: decodeURIComponent(options.toName || '同学'),
      toAvatar: decodeURIComponent(options.toAvatar || ''),
      productId: options.productId || '',
      productTitle: decodeURIComponent(options.productTitle || ''),
      productCover: decodeURIComponent(options.productCover || '')
    });

    wx.setNavigationBarTitle({ title: this.data.toName });

    this.init();
  },

  async init() {
    const app = getApp();
    try {
      const userInfo = await app.ensureLogin();
      this.setData({
        myOpenid: userInfo._openid || '',
        myAvatar: userInfo.avatarUrl || ''
      });

      // 没有 conversationId（从商品详情第一次联系）时，先算出来
      if (!this.data.conversationId) {
        const res = await call('message', 'getConversationId', {
          toId: this.data.toId,
          productId: this.data.productId
        });
        // 服务端返回 peerOpenid，存下来供发送消息使用
        this.setData({
          conversationId: res.conversationId,
          toOpenid: res.peerOpenid
        });
      }

      await this.loadHistory();
      this.startWatch();
    } catch (e) {
      this.setData({ loading: false });
      toast('进入聊天失败，请重试');
    }
  },

  /* ---------- 历史记录 ---------- */

  async loadHistory() {
    try {
      const res = await call('message', 'listMessages', {
        conversationId: this.data.conversationId,
        pageSize: 30
      });

      const messages = (res.list || []).map(m => this.decorate(m));
      this.setData({ messages, loading: false }, () => this.scrollToBottom());
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  decorate(m) {
    return {
      ...m,
      mine: m.fromOpenid === (getApp().globalData.userInfo || {})._openid,
      timeText: formatChatTime(m.createdAt)
    };
  },

  /* ---------- 实时监听 ---------- */

  startWatch() {
    const db = wx.cloud.database();
    const myId = (getApp().globalData.userInfo || {})._id;

    this.watcher = db
      .collection('messages')
      .where({ conversationId: this.data.conversationId })
      .orderBy('createdAt', 'asc')
      .watch({
        onChange: snapshot => {
          const now = Date.now();

          const messages = snapshot.docs.map(m => {
            // 新消息（30 秒内）才播放动画，避免进入页面时全部抖动
            const isNew =
              m.createdAt && now - new Date(m.createdAt).getTime() < 30 * 1000;
            return {
              ...m,
              mine: m.fromOpenid === (getApp().globalData.userInfo || {})._openid,
              timeText: formatChatTime(m.createdAt),
              isNew: isNew && m.fromOpenid !== (getApp().globalData.userInfo || {})._openid
            };
          });

          this.setData({ messages }, () => this.scrollToBottom());
        },
        onError: err => {
          console.error('[chat watch error]', err);
          // 监听失败降级为轮询，保证功能可用
          this.fallbackPolling();
        }
      });
  },

  fallbackPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.loadHistory(), 5000);
  },

  scrollToBottom() {
    const list = this.data.messages;
    if (!list.length) return;
    this.setData({ scrollIntoView: `msg-${list[list.length - 1]._id}` });
  },

  /* ---------- 发送 ---------- */

  onInput(e) {
    this.setData({ inputValue: e.detail.value });
  },

  async onSend() {
    const content = this.data.inputValue.trim();
    if (!content) return;
    if (this.data.sending) return;

    this.setData({ sending: true });

    try {
      await call(
        'message',
        'send',
        {
          // 只传 toId，peer 的 openid 由服务端从 users 表查出，
          // 避免客户端伪造 toOpenid 把消息发给第三方
          toId: this.data.toId,
          productId: this.data.productId,
          content
        },
        { silent: true }
      );

      // 清空输入框（watch 会自动把新消息推过来）
      this.setData({ inputValue: '' });
    } catch (e) {
      toast(e.message || '发送失败');
    } finally {
      this.setData({ sending: false });
    }
  },

  /* ---------- 快捷短语 ---------- */

  onQuickSend(e) {
    this.setData({ inputValue: e.currentTarget.dataset.text });
  },

  /* ---------- 商品卡片 ---------- */

  goProduct() {
    if (!this.data.productId) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${this.data.productId}` });
  },

  /* ---------- 对方主页 ---------- */

  /** 点对方头像 / 顶部信息条 → TA 的主页（点头像私聊的统一入口） */
  goPeerProfile() {
    if (!this.data.toId) return;
    wx.navigateTo({ url: `/pages/userProfile/userProfile?userId=${this.data.toId}` });
  },

  /* ---------- 生命周期 ---------- */

  onUnload() {
    // 必须关闭监听，否则页面退出后仍在消耗资源
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  onHide() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  onShow() {
    // 从后台切回来时重新建立监听
    if (!this.watcher && this.data.conversationId) {
      this.startWatch();
    }
  }
});
