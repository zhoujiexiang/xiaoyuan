// pages/verify/verify.js
const { call } = require('../../utils/request');
const { toast } = require('../../utils/util');
const config = require('../../config');

Page({
  data: {
    school: config.school,
    userInfo: null,

    realName: '',
    studentNo: '',

    submitting: false,
    verifyStatus: 'none',
    verifyReason: ''
  },

  onLoad() {
    this.loadUser();
  },

  async loadUser() {
    const app = getApp();
    try {
      const user = await app.ensureLogin();
      this.setData({
        userInfo: user,
        verifyStatus: user.verifyStatus || 'none',
        verifyReason: user.verifyReason || '',
        realName: user.realName || '',
        studentNo: user.studentNo || ''
      });
    } catch (e) {
      wx.navigateTo({ url: '/pages/login/login' });
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  validate() {
    const { realName, studentNo } = this.data;

    if (!realName.trim()) return '请填写真实姓名';
    if (realName.trim().length < 2) return '姓名格式不正确';

    if (!studentNo.trim()) return '请填写学号';
    if (!/^[0-9A-Za-z]{6,20}$/.test(studentNo.trim())) {
      return '学号格式不正确（6-20 位数字或字母）';
    }

    return null;
  },

  async onSubmit() {
    if (this.data.submitting) return;

    const error = this.validate();
    if (error) return toast(error);

    this.setData({ submitting: true });

    try {
      await call('user', 'submitVerify', {
        realName: this.data.realName.trim(),
        studentNo: this.data.studentNo.trim(),
        // 学校来自 config.js，不用用户填
        schoolId: config.school,
        schoolName: config.school
      });

      this.setData({ verifyStatus: 'pending' });

      const app = getApp();
      if (app.globalData.userInfo) {
        app.globalData.userInfo.verifyStatus = 'pending';
        wx.setStorageSync('userInfo', app.globalData.userInfo);
      }

      wx.showToast({ title: '提交成功', icon: 'success' });
    } catch (e) {
      // 错误已提示
    } finally {
      this.setData({ submitting: false });
    }
  },

  goBack() {
    wx.navigateBack();
  }
});
