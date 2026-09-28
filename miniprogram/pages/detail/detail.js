// pages/detail/detail.js
const { call } = require('../../utils/request');
const { formatPrice, formatTime, formatDeadline, toast } = require('../../utils/util');
const { PRODUCT_STATUS_TEXT, VERIFY_STATUS_TEXT, ERRAND_STATUS_TEXT, ERRAND_STATUS_CLASS } = require('../../utils/constants');

Page({
  data: {
    productId: '',
    product: null,
    seller: null,
    isFavorited: false,
    isOwner: false,

    priceText: '',
    timeText: '',
    statusText: '',
    verifyText: '',

    // 跑腿
    isErrand: false,
    isRunner: false,
    errandStatusText: '',
    errandStatusClass: '',
    deadlineText: '',

    loading: true,
    notFound: false,
    loadError: '',
    actionLoading: false
  },

  onLoad(options) {
    const raw = options && options.id;
    // 防御：某些入口曾把 undefined / null 直接拼进 URL（`?id=undefined`），
    // 这种 id 必然查不到，只会白跑一次云端并显示「商品不存在」。
    // 在这里就拦掉，并打一条能一眼看出问题源头的日志。
    const productId =
      raw && raw !== 'undefined' && raw !== 'null' ? String(raw).trim() : '';

    if (!productId) {
      console.warn('[detail] 非法的商品 id，已拦截，不发请求：' + JSON.stringify(raw));
      this.setData({ loading: false, notFound: true });
      return;
    }

    this.setData({ productId });
    this.loadDetail();
  },

  async loadDetail() {
    this.setData({ loading: true, notFound: false, loadError: '' });

    try {
      const res = await call('product', 'detail', { productId: this.data.productId });

      const p = res.product || {};
      const isErrand = p.type === 'errand';
      const me = (getApp().globalData.userInfo || {})._id;

      this.setData({
        product: p,
        seller: res.seller,
        isFavorited: res.isFavorited,
        isOwner: res.isOwner,
        priceText: formatPrice(p.price),
        timeText: formatTime(p.createdAt),
        // 同一个 on_sale，闲置叫「在售」、跑腿叫「待接单」，不能共用一张文案表
        statusText: isErrand
          ? (ERRAND_STATUS_TEXT[p.errandStatus] || '')
          : (PRODUCT_STATUS_TEXT[p.status] || ''),
        verifyText: VERIFY_STATUS_TEXT[res.seller.verifyStatus] || '',
        isErrand,
        isRunner: !!(p.runnerId && me && p.runnerId === me),
        errandStatusText: ERRAND_STATUS_TEXT[p.errandStatus] || '',
        errandStatusClass: ERRAND_STATUS_CLASS[p.errandStatus] || '',
        // 同卡片：截止时间是未来时间，不能用过去时间语义的 formatTime（会显示「刚刚」）
        deadlineText: p.deadline ? formatDeadline(p.deadline) : '',
        loading: false
      });
    } catch (e) {
      const code = e && e.code;

      if (code === 40401) {
        // 商品确实不存在/已删除。标记列表刷新，让用户返回后这张失效卡片
        // 被刷掉，否则再点一次还是同样的报错。
        // 顺手把 id 打进日志：真机上排查这类问题全靠它。
        // 用 JSON.stringify 而不是逗号拼接 —— 字符串 "undefined" 和真正的
        // undefined 在控制台长得一模一样，加引号才能一眼分清。
        console.warn('[detail] 商品不可用(40401) id=' + JSON.stringify(this.data.productId));
        const app = getApp();
        if (app && typeof app.markListRefresh === 'function') app.markListRefresh();
      }

      this.setData({
        loading: false,
        notFound: code === 40401,
        // 这里原来只有一个 wx:else 分支，导致网络异常、未登录、服务故障
        // 统统显示成「商品不存在或已被删除」，非常误导。现在按错误码分开。
        loadError: code === 40401
          ? ''
          : ((e && (e.msg || e.message)) || '加载失败，请稍后重试')
      });
    }
  },

  retry() {
    this.loadDetail();
  },

  previewImage(e) {
    const index = e.currentTarget.dataset.index;
    wx.previewImage({
      current: this.data.product.images[index],
      urls: this.data.product.images
    });
  },

  /* ---------- 收藏 ---------- */

  async toggleFavorite() {
    if (this.data.actionLoading) return;

    const app = getApp();
    try {
      await app.ensureLogin();
    } catch (e) {
      return wx.navigateTo({ url: '/pages/login/login' });
    }

    this.setData({ actionLoading: true });

    try {
      const res = await call('product', 'toggleFavorite', { productId: this.data.productId });
      // 收藏数要跟着变，否则用户点完收藏看到「0 收藏」不变，会以为没成功
      const delta = res.isFavorited ? 1 : -1;
      this.setData({
        isFavorited: res.isFavorited,
        'product.favCount': Math.max(0, (this.data.product.favCount || 0) + delta)
      });
      toast(res.isFavorited ? '已收藏' : '已取消收藏');
    } catch (e) {
      // 错误已在 request 里提示
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  /* ---------- 下单 ---------- */

  async onBuy() {
    if (this.data.actionLoading) return;

    const app = getApp();
    try {
      await app.ensureLogin();
    } catch (e) {
      return wx.navigateTo({ url: '/pages/login/login' });
    }

    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: '确认下单',
        content: `确认以 ¥${this.data.priceText} 购买「${this.data.product.title}」？\n下单后请与卖家约定面交时间地点。`,
        confirmText: '确认下单',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;

    this.setData({ actionLoading: true });
    try {
      const res = await call('order', 'create', { productId: this.data.productId });
      wx.showToast({ title: '下单成功', icon: 'success' });
      setTimeout(() => {
        wx.navigateTo({ url: `/pages/myOrders/myOrders?role=buyer` });
      }, 1000);
    } catch (e) {
      // 错误已提示
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  /* ---------- 联系卖家 ---------- */

  /** 点卖家信息行 → 卖家主页（点头像私聊的入口） */
  goSellerProfile() {
    const s = this.data.seller;
    if (!s || !s._id) return;
    wx.navigateTo({ url: `/pages/userProfile/userProfile?userId=${s._id}` });
  },

  /** 点接单人 → 接单人主页 */
  goRunnerProfile() {
    const p = this.data.product || {};
    if (!p.runnerId) return;
    wx.navigateTo({ url: `/pages/userProfile/userProfile?userId=${p.runnerId}` });
  },

  async onChat() {
    const app = getApp();
    try {
      await app.ensureLogin();
    } catch (e) {
      return wx.navigateTo({ url: '/pages/login/login' });
    }

    const { seller, product } = this.data;
    wx.navigateTo({
      url: `/pages/chat/chat?toId=${seller._id}&toName=${encodeURIComponent(seller.nickName)}&toAvatar=${encodeURIComponent(seller.avatarUrl)}&productId=${product._id}&productTitle=${encodeURIComponent(product.title)}&productCover=${encodeURIComponent(product.cover)}`
    });
  },

  /* ---------- 跑腿操作 ---------- */

  /** 接单 */
  async onAcceptErrand() {
    if (this.data.actionLoading) return;

    const app = getApp();
    try {
      await app.ensureLogin();
    } catch (e) {
      return wx.navigateTo({ url: '/pages/login/login' });
    }

    const p = this.data.product || {};
    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: '接下这个任务',
        content: `确认接下这单吗？\n\n${p.fromPlace} → ${p.toPlace}\n酬劳 ¥${this.data.priceText}，${this.data.deadlineText}前完成。`,
        confirmText: '接单',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;

    this.setData({ actionLoading: true });
    try {
      await call('product', 'errandAccept', { productId: this.data.productId });
      toast('接单成功，记得按时完成哦');
      const app2 = getApp();
      if (app2 && typeof app2.markListRefresh === 'function') app2.markListRefresh();
      this.loadDetail();
    } catch (e) {
      // 抢单失败（40311）等错误已由 request 统一提示，重新拉一次让页面状态对齐服务端
      this.loadDetail();
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  /** 确认完成（只有发布者能点） */
  async onFinishErrand() {
    if (this.data.actionLoading) return;

    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: '确认任务完成',
        content: '确认对方已经把这件事办好了吗？确认后任务结束。',
        confirmText: '确认完成',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;

    this.setData({ actionLoading: true });
    try {
      await call('product', 'errandFinish', { productId: this.data.productId });
      toast('任务已完成');
      const app = getApp();
      if (app && typeof app.markListRefresh === 'function') app.markListRefresh();
      this.loadDetail();
    } catch (e) {} finally {
      this.setData({ actionLoading: false });
    }
  },

  /** 放弃任务（接单人），任务会回到「待接单」 */
  async onAbandonErrand() {
    if (this.data.actionLoading) return;

    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: '放弃任务',
        content: '放弃后任务会重新回到「待接单」，其他同学可以接。确定放弃吗？',
        confirmText: '放弃',
        confirmColor: '#fa5151',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;

    this.setData({ actionLoading: true });
    try {
      await call('product', 'errandAbandon', { productId: this.data.productId });
      toast('已放弃该任务');
      const app = getApp();
      if (app && typeof app.markListRefresh === 'function') app.markListRefresh();
      this.loadDetail();
    } catch (e) {} finally {
      this.setData({ actionLoading: false });
    }
  },

  /** 取消任务（发布者） */
  async onCancelErrand() {
    if (this.data.actionLoading) return;

    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: '取消任务',
        content: '取消后任务将从列表移除，已接单的同学也会看到取消状态。确定取消吗？',
        confirmText: '取消任务',
        confirmColor: '#fa5151',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;

    this.setData({ actionLoading: true });
    try {
      await call('product', 'errandCancel', { productId: this.data.productId });
      toast('任务已取消');
      const app = getApp();
      if (app && typeof app.markListRefresh === 'function') app.markListRefresh();
      this.loadDetail();
    } catch (e) {} finally {
      this.setData({ actionLoading: false });
    }
  },

  /** 联系接单人（发布者视角） */
  async onChatRunner() {
    const p = this.data.product || {};
    if (!p.runnerId) return;

    const app = getApp();
    try {
      await app.ensureLogin();
    } catch (e) {
      return wx.navigateTo({ url: '/pages/login/login' });
    }

    wx.navigateTo({
      url: `/pages/chat/chat?toId=${p.runnerId}&toName=${encodeURIComponent(p.runnerName || '接单同学')}&toAvatar=${encodeURIComponent(p.runnerAvatar || '')}&productId=${this.data.productId}&productTitle=${encodeURIComponent(p.title || '')}&productCover=${encodeURIComponent(p.cover || '')}`
    });
  },

  /* ---------- 卖家操作 ---------- */

  async onOffShelf() {
    const isOff = this.data.product.status === 'off_shelf';
    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: isOff ? '重新上架' : '下架商品',
        content: isOff ? '确定要重新上架吗？' : '下架后其他同学将看不到该商品',
        // 按钮文案写清楚动作，避免误点「确定」（下架是隐藏商品的操作）
        confirmText: isOff ? '重新上架' : '下架',
        confirmColor: isOff ? '#07c160' : '#fa5151',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;

    try {
      await call('product', 'offShelf', {
        productId: this.data.productId,
        // 业务动作是 op；不能用 action（它被 request 用作云函数分发键）
        op: isOff ? 'on' : 'off'
      });
      toast(isOff ? '已重新上架' : '已下架');
      // 状态变了，列表里的角标要跟着更新
      const app = getApp();
      if (app && typeof app.markListRefresh === 'function') app.markListRefresh();
      this.loadDetail();
    } catch (e) {}
  },

  async onDelete() {
    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: '删除商品',
        content: '删除后无法恢复，确定要删除吗？',
        confirmColor: '#fa5151',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;

    try {
      await call('product', 'remove', { productId: this.data.productId });
      toast('已删除');
      // 列表里这张卡片必须被刷掉，否则返回后再点还是「商品不存在」
      const app = getApp();
      if (app && typeof app.markListRefresh === 'function') app.markListRefresh();
      setTimeout(() => wx.navigateBack(), 1000);
    } catch (e) {}
  },

  /* ---------- 分享 ---------- */

  /**
   * 转发给同学
   * path 必须带上 id，否则对方打开的是空白详情页
   */
  onShareAppMessage() {
    const p = this.data.product || {};
    const share = {
      title: p.title ? `【¥${p.price}】${p.title}` : '校园二手 · 好物转让',
      path: `/pages/detail/detail?id=${this.data.productId}`
    };
    if (p.images && p.images[0]) share.imageUrl = p.images[0];
    return share;
  },

  onShareTimeline() {
    const p = this.data.product || {};
    const share = {
      title: p.title ? `【¥${p.price}】${p.title}` : '校园二手 · 好物转让',
      query: `id=${this.data.productId}`
    };
    if (p.images && p.images[0]) share.imageUrl = p.images[0];
    return share;
  },

  /* ---------- 举报 ---------- */

  onReport() {
    wx.showActionSheet({
      itemList: ['虚假信息', '违禁物品', '价格欺诈', '骚扰辱骂', '其他'],
      success: async res => {
        const reasons = ['虚假信息', '违禁物品', '价格欺诈', '骚扰辱骂', '其他'];
        try {
          await call('product', 'report', {
            targetType: 'product',
            targetId: this.data.productId,
            reason: reasons[res.tapIndex]
          });
          toast('举报已提交，我们会尽快处理');
        } catch (e) {}
      }
    });
  },

  goBack() {
    wx.navigateBack();
  }
});
