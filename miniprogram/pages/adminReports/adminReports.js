// pages/adminReports/adminReports.js — 举报处理
const { call } = require('../../utils/request');
const { formatTime, toast } = require('../../utils/util');

const PAGE_SIZE = 20;

const TABS = [
  { key: 'pending', label: '待处理' },
  { key: 'handled', label: '已下架' },
  { key: 'ignored', label: '已忽略' }
];

Page({
  data: {
    tabs: TABS,
    activeTab: 'pending',
    list: [],
    cursor: null,
    hasMore: true,
    loading: false,
    acting: false
  },

  onLoad() {
    this.loadList(true);
  },

  async loadList(reset = false) {
    if (this.data.loading) return;
    if (!reset && !this.data.hasMore) return;

    this.setData({ loading: true });

    try {
      const res = await call('admin', 'listReports', {
        status: this.data.activeTab,
        cursor: reset ? undefined : this.data.cursor || undefined,
        pageSize: PAGE_SIZE
      });

      const list = (res.list || []).map(r => ({
        ...r,
        timeText: formatTime(r.createdAt)
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

  goProduct(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  /** 下架商品并标记已处理 */
  async onBlock(e) {
    const { id, title } = e.currentTarget.dataset;

    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: '下架商品',
        content: `确认下架「${title || '该商品'}」？下架后其他用户将看不到。`,
        confirmColor: '#fa5151',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;

    await this.doHandle(id, 'block');
  },

  /** 忽略举报 */
  async onIgnore(e) {
    const { id } = e.currentTarget.dataset;

    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: '忽略举报',
        content: '确认该举报不成立？商品将保持原状。',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;

    await this.doHandle(id, 'ignore');
  },

  async doHandle(reportId, op) {
    if (this.data.acting) return;
    this.setData({ acting: true });

    try {
      // 发 op，不能用 action（它是云函数分发键）
      await call('admin', 'handleReport', { reportId, op });
      toast(op === 'block' ? '已下架' : '已忽略');
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
