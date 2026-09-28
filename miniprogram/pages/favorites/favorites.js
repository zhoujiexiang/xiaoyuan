// pages/favorites/favorites.js
const { call } = require('../../utils/request');

const PAGE_SIZE = 10;

Page({
  data: {
    list: [],
    cursor: null,
    hasMore: true,
    loading: false
  },

  onLoad() {
    // ⚠️ 必须在这里拉一次：本页原来只有 onShow，而 onShow 里用
    // `if (this.loaded)` 做守卫 —— 首次进入时 this.loaded 是 undefined，
    // 于是**永远不进 loadList**，页面一直显示「还没有收藏任何商品」，
    // 用户收藏了东西也看不到（真实缺陷）。myOrders / myProducts 都有
    // onLoad 兜底，唯独这里漏了。
    this.loadList(true);
  },

  onShow() {
    // 首次进入由 onLoad 拉取；从详情页返回时（可能取消了收藏）再拉一次
    if (this.loaded) this.loadList(true);
    this.loaded = true;
  },

  async loadList(reset = false) {
    if (this.data.loading) return;
    if (!reset && !this.data.hasMore) return;

    this.setData({ loading: true });

    try {
      const res = await call('product', 'myFavorites', {
        cursor: reset ? undefined : this.data.cursor || undefined,
        pageSize: PAGE_SIZE
      });

      this.setData({
        list: reset ? res.list : this.data.list.concat(res.list),
        cursor: res.nextCursor,
        hasMore: res.hasMore,
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  onReachBottom() {
    this.loadList(false);
  },

  onPullDownRefresh() {
    this.setData({ cursor: null, hasMore: true });
    this.loadList(true).then(() => wx.stopPullDownRefresh());
  },

  onCardTap(e) {
    const id = e.detail && e.detail.id;
    // 防线：detail 为空时不跳转（详见 product-card 组件里的说明）
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
