// pages/myProducts/myProducts.js
const { call } = require('../../utils/request');
const { toast } = require('../../utils/util');

const PAGE_SIZE = 10;

const TABS = [
  { key: '', label: '全部' },
  { key: 'on_sale', label: '在售' },
  { key: 'sold', label: '已售出' },
  { key: 'off_shelf', label: '已下架' }
];

Page({
  data: {
    tabs: TABS,
    activeTab: '',
    list: [],
    cursor: null,
    hasMore: true,
    loading: false,
    acting: false
  },

  onLoad(options) {
    const status = options.status || '';
    this.setData({ activeTab: status });
    this.loadList(true);
  },

  onShow() {
    // onLoad 已经拉过一次，这里只处理「返回本页」的情况。
    // 详情页把商品删除/下架之后返回，旧卡片若还留在列表里，再点进去
    // 就会报「商品不存在或已被删除」——所以每次回到本页都重新拉一次。
    if (this.loaded) this.loadList(true);
    this.loaded = true;
  },

  async loadList(reset = false) {
    if (this.data.loading) return;
    if (!reset && !this.data.hasMore) return;

    this.setData({ loading: true });

    try {
      const res = await call('product', 'myList', {
        status: this.data.activeTab || undefined,
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

  onTabTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeTab) return;
    this.setData({ activeTab: key, list: [], cursor: null, hasMore: true });
    this.loadList(true);
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

  /** 列表里直接下架 / 重新上架 */
  async onToggleShelf(e) {
    const { id, status, title } = e.currentTarget.dataset;
    const isOff = status === 'off_shelf';

    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: isOff ? '重新上架' : '下架商品',
        content: isOff
          ? `确认重新上架「${title}」？其他同学将重新看到该商品。`
          : `确认下架「${title}」？下架后其他同学将看不到。`,
        confirmColor: isOff ? '#07c160' : '#fa5151',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;
    if (this.data.acting) return;

    this.setData({ acting: true });
    try {
      // 注意是 op 不是 action：action 会被 request 当作云函数分发键
      await call('product', 'offShelf', { productId: id, op: isOff ? 'on' : 'off' });
      toast(isOff ? '已重新上架' : '已下架');
      this.loadList(true);
    } catch (err) {
      // 错误已提示
    } finally {
      this.setData({ acting: false });
    }
  },

  goPublish() {
    wx.switchTab({ url: '/pages/publish/publish' });
  }
});
