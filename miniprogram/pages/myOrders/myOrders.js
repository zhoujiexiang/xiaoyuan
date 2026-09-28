// pages/myOrders/myOrders.js
const { call } = require('../../utils/request');
const { formatTime, formatPrice, toast } = require('../../utils/util');
const { ORDER_STATUS_TEXT } = require('../../utils/constants');

const PAGE_SIZE = 10;

const TABS = [
  { key: '', label: '全部' },
  { key: 'pending', label: '待确认' },
  { key: 'trading', label: '交易中' },
  { key: 'done', label: '已完成' }
];

Page({
  data: {
    role: 'buyer',
    tabs: TABS,
    activeTab: '',
    list: [],
    cursor: null,
    hasMore: true,
    loading: false,
    actionLoading: false
  },

  onLoad(options) {
    const role = options.role === 'seller' ? 'seller' : 'buyer';
    wx.setNavigationBarTitle({ title: role === 'buyer' ? '我买到的' : '我卖出的' });
    this.setData({ role });
    this.loadList(true);
  },

  onShow() {
    // 从详情页下单后返回需要刷新
    if (this.loaded) this.loadList(true);
    this.loaded = true;
  },

  async loadList(reset = false) {
    if (this.data.loading) return;
    if (!reset && !this.data.hasMore) return;

    this.setData({ loading: true });

    try {
      const res = await call('order', 'list', {
        role: this.data.role,
        status: this.data.activeTab || undefined,
        cursor: reset ? undefined : this.data.cursor || undefined,
        pageSize: PAGE_SIZE
      });

      const list = (res.list || []).map(o => this.decorate(o));

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

  decorate(o) {
    return {
      ...o,
      priceText: formatPrice(o.price),
      timeText: formatTime(o.createdAt),
      statusText: ORDER_STATUS_TEXT[o.status] || o.status,
      statusClass: this.getStatusClass(o.status),
      isBuyer: this.data.role === 'buyer',
      // 不同角色 + 不同状态，可执行的操作不同
      buttons: this.getButtons(o)
    };
  },

  getStatusClass(status) {
    if (status === 'done') return 'tag-green';
    if (status === 'canceled') return 'tag-gray';
    if (status === 'trading') return 'tag-orange';
    return 'tag-red';
  },

  getButtons(order) {
    const isBuyer = this.data.role === 'buyer';
    const btns = [];

    if (order.status === 'pending') {
      if (isBuyer) {
        btns.push({ action: 'cancel', text: '取消订单', type: 'plain' });
      } else {
        btns.push({ action: 'reject', text: '拒绝', type: 'plain' });
        btns.push({ action: 'accept', text: '同意交易', type: 'primary' });
      }
    } else if (order.status === 'trading') {
      btns.push({ action: 'cancel', text: '取消订单', type: 'plain' });
      btns.push({ action: 'complete', text: '确认完成', type: 'primary' });
    }

    return btns;
  },

  onTabTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeTab) return;
    this.setData({ activeTab: key, list: [], cursor: null, hasMore: true });
    this.loadList(true);
  },

  async onActionTap(e) {
    if (this.data.actionLoading) return;

    const { action, orderid } = e.currentTarget.dataset;
    const order = this.data.list.find(o => o._id === orderid);
    if (!order) return;

    const confirms = {
      accept: { title: '同意交易', content: '同意后商品将标记为已售出，请与买家约定面交时间地点' },
      reject: { title: '拒绝订单', content: '确定要拒绝这个订单吗？' },
      cancel: { title: '取消订单', content: '确定要取消这个订单吗？商品将重新上架' },
      complete: { title: '确认完成', content: '确认已完成交易？完成后不可撤销' }
    };

    const cfg = confirms[action];
    if (!cfg) return;

    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: cfg.title,
        content: cfg.content,
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;

    this.setData({ actionLoading: true });

    try {
      // dataset 里的 action 只是本地标记，发给云函数时必须改名 op，
      // 否则会顶掉云函数的分发键，请求落到「未知的操作」
      await call('order', 'updateStatus', { orderId: orderid, op: action });
      toast('操作成功');
      this.loadList(true);
    } catch (e) {
      // 错误已提示
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  goProduct(e) {
    const productId = e.currentTarget.dataset.productid;
    if (!productId) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${productId}` });
  },

  onReachBottom() {
    this.loadList(false);
  },

  onPullDownRefresh() {
    this.setData({ cursor: null, hasMore: true });
    this.loadList(true).then(() => wx.stopPullDownRefresh());
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
