// pages/adminProducts/adminProducts.js — 商品管理
const { call } = require('../../utils/request');
const { formatTime, toast, debounce } = require('../../utils/util');

const PAGE_SIZE = 20;

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'on_sale', label: '在售' },
  { key: 'sold', label: '已售' },
  { key: 'blocked', label: '已下架' }
];

Page({
  data: {
    tabs: TABS,
    activeTab: 'all',
    keyword: '',
    list: [],
    cursor: null,
    hasMore: true,
    loading: false,
    acting: false
  },

  onLoad() {
    this.searchDebounced = debounce(() => this.loadList(true), 400);
    this.loadList(true);
  },

  async loadList(reset = false) {
    if (this.data.loading) return;
    if (!reset && !this.data.hasMore) return;

    this.setData({ loading: true });

    try {
      const res = await call('admin', 'listProducts', {
        status: this.data.activeTab,
        keyword: this.data.keyword || undefined,
        cursor: reset ? undefined : this.data.cursor || undefined,
        pageSize: PAGE_SIZE
      });

      const list = (res.list || []).map(p => ({
        ...p,
        timeText: formatTime(p.createdAt)
      }));

      this.setData({
        list: reset ? list : this.data.list.concat(list),
        cursor: res.nextCursor,
        hasMore: res.hasMore,
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  onTabTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeTab) return;
    this.setData({ activeTab: key, list: [], cursor: null, hasMore: true });
    this.loadList(true);
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value, cursor: null, hasMore: true });
    this.searchDebounced();
  },

  goProduct(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  /** 下架 / 恢复 */
  async onToggle(e) {
    const { id, status, title } = e.currentTarget.dataset;
    const isBlocked = status === 'blocked';
    const op = isBlocked ? 'restore' : 'block';

    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: isBlocked ? '恢复商品' : '下架商品',
        content: isBlocked
          ? `确认恢复「${title}」？恢复后其他用户可以看到。`
          : `确认下架「${title}」？下架后其他用户将看不到。`,
        confirmColor: isBlocked ? '#07c160' : '#fa5151',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;

    if (this.data.acting) return;
    this.setData({ acting: true });

    try {
      // 发 op，不能用 action（它是云函数分发键）
      await call('admin', 'blockProduct', { productId: id, op });
      toast(isBlocked ? '已恢复' : '已下架');
      this.loadList(true);
    } catch (e) {
      // 错误已提示
    } finally {
      this.setData({ acting: false });
    }
  },

  onReachBottom() {
    this.loadList(false);
  },

  onPullDownRefresh() {
    this.setData({ cursor: null, hasMore: true });
    this.loadList(true).then(() => wx.stopPullDownRefresh());
  }
});
