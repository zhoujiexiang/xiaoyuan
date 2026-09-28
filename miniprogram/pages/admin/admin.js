// pages/admin/admin.js — 管理后台首页
const { call } = require('../../utils/request');

Page({
  data: {
    stats: {
      pendingVerify: 0,
      pendingReports: 0,
      onSaleProducts: 0,
      totalUsers: 0,
      totalOrders: 0
    },
    isBootstrap: false,
    loading: true,
    noPerm: false
  },

  onShow() {
    this.loadStats();
  },

  async loadStats() {
    try {
      const res = await call('admin', 'stats', {}, { silent: true });
      this.setData({ stats: res, loading: false, noPerm: false });
    } catch (e) {
      if (e.code === 40202) {
        this.setData({ noPerm: true, loading: false });
      } else {
        this.setData({ loading: false });
      }
    }
  },

  goVerifyList() {
    wx.navigateTo({ url: '/pages/adminVerify/adminVerify' });
  },

  goReportList() {
    wx.navigateTo({ url: '/pages/adminReports/adminReports' });
  },

  goProductList() {
    wx.navigateTo({ url: '/pages/adminProducts/adminProducts' });
  },

  onPullDownRefresh() {
    this.loadStats().then(() => wx.stopPullDownRefresh());
  },

  goBack() {
    wx.navigateBack();
  }
});
