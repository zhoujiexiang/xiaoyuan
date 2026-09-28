// pages/profile/profile.js
const { call, uploadImage } = require('../../utils/request');
const { toast } = require('../../utils/util');

const DEFAULT_NICK = '微信用户';

Page({
  data: {
    nickName: '',
    avatarUrl: '',
    // 是否刚选了新头像（只有新选的才需要重新上传）
    avatarPicked: false,
    saving: false
  },

  onLoad() {
    const user = getApp().globalData.userInfo || {};
    this.setData({
      // 昵称还是系统默认值时留空，让 placeholder 提示用户去填
      nickName: !user.nickName || user.nickName === DEFAULT_NICK ? '' : user.nickName,
      avatarUrl: user.avatarUrl || ''
    });
  },

  /**
   * 选择头像
   *
   * 这里必须用 open-type="chooseAvatar"：
   * wx.getUserProfile 自 2022-10-25 起只返回匿名数据（灰头像 +「微信用户」），
   * 拿不到用户真实头像了。
   *
   * e.detail.avatarUrl 是本地临时路径，不能直接存库
   * —— 临时文件重启后失效，所以保存时先传云存储换成 fileID。
   */
  onChooseAvatar(e) {
    const localPath = e.detail && e.detail.avatarUrl;
    if (!localPath) return;
    this.setData({ avatarUrl: localPath, avatarPicked: true });
  },

  onNickChange(e) {
    this.setData({ nickName: String((e.detail && e.detail.value) || '').trim() });
  },

  async onSave() {
    if (this.data.saving) return;

    const nickName = this.data.nickName.trim();
    if (!nickName) return toast('请填写昵称');
    if (nickName.length > 20) return toast('昵称不能超过 20 个字');

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中…', mask: true });

    try {
      let avatarUrl = this.data.avatarUrl;

      // 本地临时路径 → 云存储 fileID
      // 注意：用 indexOf 判断，不要写成 /^cloud:\/\//，正则里的转义容易被写坏
      if (this.data.avatarPicked && avatarUrl.indexOf('cloud://') !== 0) {
        avatarUrl = await uploadImage(avatarUrl, 'avatars');
      }

      // 复用 login 接口：已存在的用户只更新昵称头像，其他字段不动
      const user = await call('user', 'login', {
        nickName,
        avatarUrl,
        schoolId: undefined,
        schoolName: undefined
      });

      const app = getApp();
      app.globalData.userInfo = user;
      wx.setStorageSync('userInfo', user);

      wx.hideLoading();
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => this.goBack(), 700);
    } catch (e) {
      wx.hideLoading();
      toast((e && (e.msg || e.message)) || '保存失败，请重试');
    } finally {
      this.setData({ saving: false });
    }
  },

  /** 从登录页 redirectTo 过来时栈里可能只有本页，兜底回「我的」 */
  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/mine/mine' });
  }
});
