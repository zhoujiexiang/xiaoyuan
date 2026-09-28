// pages/index/index.js — 首页商品列表
const { call } = require('../../utils/request');
const { CATEGORIES } = require('../../utils/constants');
const config = require('../../config');

const PAGE_SIZE = 10;

Page({
  data: {
    categories: CATEGORIES,
    // 内容类型：goods=二手闲置 / errand=校园跑腿
    contentType: 'goods',
    activeCategory: '',      // '' = 全部
    list: [],
    cursor: null,
    hasMore: true,
    loading: false,
    refreshing: false,
    banners: [
      { text: '同校交易 · 面交更放心', sub: '只显示本校同学的闲置' }
    ],
    // 跑腿模式下换一套文案，否则会出现「这里还没有商品」这种对不上号的说法
    emptyIcon: '🛒',
    emptyText: '这里还没有商品，去发布第一个吧',
    emptyBtn: '发布闲置'
  },

  onLoad() {
    this.loadList(true);
  },

  onShow() {
    this.applyPendingType();
    this.maybeRefreshList();
  },

  /**
   * 发布页发完东西后要告诉首页切到对应 tab。
   * 但 switchTab 不支持带参数，所以只能走全局暂存 → 首页 onShow 时消费。
   */
  applyPendingType() {
    const app = getApp();
    const type = app.globalData.pendingIndexType;
    if (!type) return;

    app.globalData.pendingIndexType = '';
    if (type === this.data.contentType) return;
    this.switchType(type);
  },

  /**
   * 消费「列表需要刷新」标记并重拉。
   *
   * 关键：标记必须在**真正发起刷新**的那一刻才消费。
   * 之前是一进 onShow 就 consume，而 loadList 开头有
   * `if (this.data.loading) return;` —— 如果此刻刚好有请求在飞，
   * 标记被吃掉、刷新却没发生，列表就仍是旧的（用户点到失效卡片）。
   */
  maybeRefreshList() {
    const app = getApp();
    const flagged =
      app && typeof app.hasListRefresh === 'function' ? app.hasListRefresh() : false;

    if (!this.needRefresh && !flagged) return;

    if (this.data.loading) {
      // 正在加载：这次加载拿到的是新数据，标记留到加载结束后再处理
      this.pendingRefresh = true;
      return;
    }

    this.needRefresh = false;
    this.pendingRefresh = false;
    if (app && typeof app.consumeListRefresh === 'function') app.consumeListRefresh();
    this.loadList(true);
  },

  // 兼容保留：外部若能拿到首页实例，仍可直接标记（tabBar 页面之间通常拿不到）
  markNeedRefresh() {
    this.needRefresh = true;
  },

  async loadList(reset = false) {
    if (this.data.loading) return;
    if (!reset && !this.data.hasMore) return;

    this.setData({ loading: true });

    try {
      const res = await call(
        'product',
        'list',
        {
          type: this.data.contentType,
          // 跑腿没有分类体系，带上 categoryId 会永远查不到东西
          categoryId:
            this.data.contentType === 'goods'
              ? (this.data.activeCategory || undefined)
              : undefined,
          cursor: reset ? undefined : this.data.cursor || undefined,
          pageSize: PAGE_SIZE
        },
        { silent: reset } // 下拉刷新失败时不弹 toast，避免打扰
      );

      const list = reset ? res.list : this.data.list.concat(res.list);

      this.setData({
        list,
        cursor: res.nextCursor,
        hasMore: res.hasMore,
        loading: false,
        refreshing: false
      });
    } catch (e) {
      this.setData({ loading: false, refreshing: false });
    }

    // 加载期间被暂存的刷新标记，现在补上（加载完再判断，不会死循环）
    if (this.pendingRefresh) {
      this.pendingRefresh = false;
      this.maybeRefreshList();
    }
  },

  /** 切换「二手闲置 / 校园跑腿」 */
  onTypeTap(e) {
    const type = e.currentTarget.dataset.type === 'errand' ? 'errand' : 'goods';
    if (type === this.data.contentType) return;
    this.switchType(type);
  },

  /**
   * 真正切类型。文案/图标/空态都跟着变 —— 跑腿下还写「这里还没有商品」
   * 用户会以为点错了页面。
   */
  switchType(type) {
    const isErrand = type === 'errand';

    this.setData({
      contentType: type,
      // 分类只在闲置下有意义，切过去顺手清掉，免得带着分类去查跑腿（永远查不到）
      activeCategory: '',
      list: [],
      cursor: null,
      hasMore: true,
      banners: isErrand
        ? [{ text: '校园跑腿 · 有事找人搭把手', sub: '发布任务，同学接单' }]
        : [{ text: '同校交易 · 面交更放心', sub: '只显示本校同学的闲置' }],
      emptyIcon: isErrand ? '🛵' : '🛒',
      emptyText: isErrand ? '还没有跑腿任务，发一个试试' : '这里还没有商品，去发布第一个吧',
      emptyBtn: isErrand ? '发布跑腿' : '发布闲置'
    });

    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
    this.loadList(true);
  },

  onCategoryTap(e) {
    const id = e.currentTarget.dataset.id || '';
    if (id === this.data.activeCategory) return;

    this.setData({ activeCategory: id, list: [], cursor: null, hasMore: true });
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
    this.loadList(true);
  },

  onReachBottom() {
    this.loadList(false);
  },

  async onPullDownRefresh() {
    this.setData({ refreshing: true, cursor: null, hasMore: true });
    await this.loadList(true);
    wx.stopPullDownRefresh();
  },

  onCardTap(e) {
    const id = e.detail && e.detail.id;
    // 防线：曾经组件的自定义事件与内置 tap 同名，原生事件冒泡上来时 detail 为空，
    // 会拼出 ?id=undefined 并跳到「商品不存在」页。宁可不跳，也不跳到一个坏页面。
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  /** 点卡片上的卖家头像 → 对方主页（在那里可以发消息私聊） */
  onSellerTap(e) {
    const sellerId = e.detail && e.detail.sellerId;
    if (!sellerId) return;
    wx.navigateTo({ url: `/pages/userProfile/userProfile?userId=${sellerId}` });
  },

  /* ---------- 分享 ---------- */

  onShareAppMessage() {
    return {
      title: `${config.school} · 校园二手好物`,
      path: '/pages/index/index'
    };
  },

  onShareTimeline() {
    return { title: `${config.school} · 校园二手好物` };
  },

  goSearch() {
    // 跑腿 tab 进来默认搜跑腿；搜索页内也可以再切回闲置
    const type = this.data.contentType === 'errand' ? '?type=errand' : '';
    wx.navigateTo({ url: '/pages/search/search' + type });
  },

  goPublish() {
    // 带着当前类型去发布页：在跑腿列表点「发布跑腿」进来，表单默认就是跑腿
    const mode = this.data.contentType === 'errand' ? 'errand' : 'goods';
    wx.switchTab({ url: '/pages/publish/publish' });
    // switchTab 不能带参数，用全局暂存告诉发布页该默认哪个 tab
    getApp().globalData.publishMode = mode;
  }
});
