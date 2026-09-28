// pages/myErrands/myErrands.js — 我的跑腿（我发布的 / 我接的）
const { call } = require('../../utils/request');
const { toast } = require('../../utils/util');

Page({
  data: {
    role: 'publisher',   // publisher=我发布的 / runner=我接的
    list: [],
    loading: true,
    needLogin: false,
    errorText: '',
    acting: false        // 正在删除，防连点
  },

  onLoad(options) {
    const role = options && options.role === 'runner' ? 'runner' : 'publisher';
    this.setData({ role });
  },

  onShow() {
    this.init();
  },

  async init() {
    const app = getApp();
    try {
      await app.ensureLogin();
      this.setData({ needLogin: false });
      this.loadList();
    } catch (e) {
      this.setData({ needLogin: true, loading: false });
    }
  },

  switchRole(e) {
    const role = e.currentTarget.dataset.role === 'runner' ? 'runner' : 'publisher';
    if (role === this.data.role) return;
    this.setData({ role, list: [], loading: true, errorText: '' });
    this.loadList();
  },

  async loadList() {
    try {
      const res = await call(
        'product',
        'errandMyList',
        { role: this.data.role },
        { silent: true }
      );
      this.setData({ list: res.list || [], loading: false, errorText: '' });
    } catch (e) {
      // 把真实原因显示出来，否则用户只看到一片空白，不知道是没登录还是服务挂了
      this.setData({
        loading: false,
        errorText: (e && (e.msg || e.message)) || '加载失败，请稍后重试'
      });
    }
  },

  onPullDownRefresh() {
    this.loadList().then(() => wx.stopPullDownRefresh());
  },

  onCardTap(e) {
    const id = e.detail && e.detail.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  /**
   * 删除已结束的跑腿任务（已取消 / 已完成）。
   *
   * 只给「我发布的」用：接单人没有权限删发布者的记录，所以 runner 那一栏
   * 模板上就不会渲染这个按钮（云函数那边也会再拦一道 sellerId）。
   * 进行中的任务不给删 —— 可能有人正接着单，删掉会让对方的东西凭空消失，
   * 云函数会返回 40312。
   */
  onDelete(e) {
    const { id, title } = e.currentTarget.dataset;
    if (!id || this.data.acting) return;

    wx.showModal({
      title: '删除任务',
      content: `确认删除「${title || '这条任务'}」？删除后不再出现在你的跑腿列表。`,
      confirmText: '删除',
      confirmColor: '#fa5151',
      success: async r => {
        if (!r.confirm) return;
        // showModal 的回调本身不阻塞，setData 到 this 上仍有 this 指向，
        // 但 async 里必须先判断一次，避免确认弹窗连点触发两次请求
        if (this.data.acting) return;

        this.setData({ acting: true });
        try {
          await call('product', 'errandRemove', { productId: id });
          toast('已删除');
          // 就地重拉，不用用户手动下拉；这一条已经不在列表里了
          await this.loadList();
        } catch (err) {
          toast((err && (err.msg || err.message)) || '删除失败，请重试');
        } finally {
          this.setData({ acting: false });
        }
      }
    });
  },

  goPublish() {
    getApp().globalData.publishMode = 'errand';
    wx.switchTab({ url: '/pages/publish/publish' });
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  }
});
