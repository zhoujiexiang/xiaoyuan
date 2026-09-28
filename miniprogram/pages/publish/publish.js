// pages/publish/publish.js
const { call, uploadImage } = require('../../utils/request');
const { CATEGORIES, ERRAND_TYPES } = require('../../utils/constants');
const { toast, pad } = require('../../utils/util');

const MAX_IMAGES = 9;

/** 默认的期望完成时间：今天 18:00；已经过了就顺延到明天 */
function defaultDeadline() {
  const d = new Date();
  d.setHours(18, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toTimeStr(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

Page({
  data: {
    categories: CATEGORIES,
    errandTypes: ERRAND_TYPES,

    // 发布模式：goods=卖闲置 / errand=发跑腿
    mode: 'goods',

    // 表单数据（闲置和跑腿共用的部分）
    images: [],           // 本地临时路径，用于预览
    title: '',
    desc: '',
    price: '',
    contact: '',

    // 闲置专属
    oriPrice: '',
    categoryId: '',
    categoryName: '',
    tradePlace: '',

    // 跑腿专属
    errandType: '',
    errandTypeName: '',
    fromPlace: '',
    toPlace: '',
    deadlineDate: '',
    deadlineTime: '18:00',
    deadlineText: '',
    deadline: null,       // 时间戳，提交时给云函数
    today: '',            // 日期选择器的最早可选日期

    submitting: false,
    // 页面进入时是否需要登录拦截
    needLogin: false
  },

  onLoad() {
    const d = defaultDeadline();
    this.setData({
      today: toDateStr(new Date()),
      deadlineDate: toDateStr(d),
      deadlineTime: toTimeStr(d)
    });
    this.syncDeadline();
    this.syncTitle();
  },

  onShow() {
    this.checkLogin();
    this.applyPendingMode();
  },

  /**
   * 首页在跑腿列表点「发布跑腿」进来时，表单要默认停在跑腿这栏。
   * switchTab 不能带参数，所以首页把意图放在 globalData 里，这里消费。
   */
  applyPendingMode() {
    const app = getApp();
    const mode = app.globalData.publishMode;
    if (!mode) return;

    app.globalData.publishMode = '';
    if (mode === this.data.mode) return;
    this.setData({ mode: mode === 'errand' ? 'errand' : 'goods' });
    this.syncTitle();
  },

  onModeTap(e) {
    const mode = e.currentTarget.dataset.mode === 'errand' ? 'errand' : 'goods';
    if (mode === this.data.mode) return;
    // 标题/描述/价格/图片是两种内容都用的，切换时保留，不打断正在写的内容
    this.setData({ mode });
    this.syncTitle();
  },

  /** 导航栏标题跟着模式走，不然发跑腿时顶上还写着「发布闲置」 */
  syncTitle() {
    wx.setNavigationBarTitle({
      title: this.data.mode === 'errand' ? '发布跑腿' : '发布闲置'
    });
  },

  async checkLogin() {
    const app = getApp();
    try {
      await app.ensureLogin();
      this.setData({ needLogin: false });
    } catch (e) {
      this.setData({ needLogin: true });
    }
  },

  /* ---------- 图片 ---------- */

  chooseImage() {
    const remain = MAX_IMAGES - this.data.images.length;
    if (remain <= 0) return toast(`最多上传 ${MAX_IMAGES} 张图片`);

    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],   // 压缩图，省流量也省存储
      sourceType: ['album', 'camera'],
      success: res => {
        const paths = res.tempFiles.map(f => f.tempFilePath);
        this.setData({ images: this.data.images.concat(paths) });
      }
    });
  },

  previewImage(e) {
    const index = e.currentTarget.dataset.index;
    wx.previewImage({
      current: this.data.images[index],
      urls: this.data.images
    });
  },

  deleteImage(e) {
    const index = e.currentTarget.dataset.index;
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({ images });
  },

  /* ---------- 表单 ---------- */

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  onCategoryChange(e) {
    const index = e.detail.value;
    const cate = this.data.categories[index];
    this.setData({ categoryId: cate.id, categoryName: cate.name });
  },

  /* ---------- 跑腿 ---------- */

  onErrandTypeTap(e) {
    const { id, name } = e.currentTarget.dataset;
    this.setData({ errandType: id, errandTypeName: name });
  },

  onDeadlineDateChange(e) {
    this.setData({ deadlineDate: e.detail.value });
    this.syncDeadline();
  },

  onDeadlineTimeChange(e) {
    this.setData({ deadlineTime: e.detail.value });
    this.syncDeadline();
  },

  /**
   * 把「日期 + 时间」两个 picker 合成一个时间戳。
   * 不要用 new Date('2026-09-18 18:00') —— 各端对无时区字符串的解析规则不一致，
   * 手动构造年月日是唯一稳的做法。
   */
  syncDeadline() {
    const { deadlineDate, deadlineTime } = this.data;
    if (!deadlineDate) return;

    const dParts = String(deadlineDate).split('-').map(Number);
    const tParts = String(deadlineTime || '18:00').split(':').map(Number);
    if (dParts.length < 3 || dParts.some(isNaN)) return;

    const d = new Date(
      dParts[0],
      dParts[1] - 1,
      dParts[2],
      tParts[0] || 0,
      tParts[1] || 0,
      0,
      0
    );

    this.setData({
      deadline: d.getTime(),
      deadlineText: `${deadlineDate} ${deadlineTime}`
    });
  },

  /* ---------- 提交 ---------- */

  validate() {
    const { images, title, desc, price } = this.data;
    const isErrand = this.data.mode === 'errand';

    // 闲置必须配图，跑腿可以不配（很多时候就是「帮我去驿站拿个快递」）
    if (!isErrand && images.length === 0) return '至少上传 1 张图片';
    if (!title.trim()) return '请填写标题';
    if (title.trim().length > 30) return '标题不能超过 30 字';
    if (!desc.trim()) return '请填写描述';
    if (desc.trim().length > 500) return '描述不能超过 500 字';

    const p = Number(price);
    if (!price || isNaN(p)) return isErrand ? '请填写酬劳' : '请填写正确的价格';
    if (p <= 0) return isErrand ? '酬劳必须大于 0' : '价格必须大于 0';
    if (p > 99999) return '金额过高';

    if (isErrand) {
      if (!this.data.errandType) return '请选择跑腿类型';
      if (!this.data.fromPlace.trim()) return '请填写取件/购买地点';
      if (!this.data.toPlace.trim()) return '请填写送达地点';
      if (!this.data.deadline) return '请选择期望完成时间';
      // 云函数也会校验一次，这里先挡一遍，省一次往返
      if (this.data.deadline <= Date.now()) return '期望完成时间要晚于现在';
      return null;
    }

    if (this.data.oriPrice) {
      const op = Number(this.data.oriPrice);
      if (isNaN(op) || op <= 0) return '原价格式不正确';
    }

    if (!this.data.categoryId) return '请选择分类';
    if (!this.data.tradePlace.trim()) return '请填写面交地点';

    return null;
  },

  async onSubmit() {
    if (this.data.submitting) return;

    const error = this.validate();
    if (error) return toast(error);

    const isErrand = this.data.mode === 'errand';
    const app = getApp();

    // 发布需要认证，未认证引导去认证
    if (!app.isVerified()) {
      const res = await new Promise(resolve =>
        wx.showModal({
          title: '需要校园认证',
          content: '发布需要先完成校园认证，是否现在去认证？',
          confirmText: '去认证',
          success: resolve,
          fail: () => resolve({ confirm: false })
        })
      );
      if (res.confirm) wx.navigateTo({ url: '/pages/verify/verify' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: isErrand ? '发布任务中…' : '发布中…', mask: true });

    try {
      // 1. 先上传图片（并发上传，比串行快很多）
      const fileIDs = await this.uploadAll(this.data.images);

      // 2. 图片内容安全：有违规图就整单拦下，并清理刚上传的文件
      await this.checkImages(fileIDs);

      // 3. 提交
      const res = await call(
        'product',
        'publish',
        {
          type: isErrand ? 'errand' : 'goods',
          title: this.data.title.trim(),
          desc: this.data.desc.trim(),
          price: Number(this.data.price),
          oriPrice: !isErrand && this.data.oriPrice ? Number(this.data.oriPrice) : undefined,
          images: fileIDs,
          categoryId: isErrand ? '' : this.data.categoryId,
          categoryName: isErrand ? '' : this.data.categoryName,
          // 跑腿列表卡片上显示的就是送达地点
          tradePlace: isErrand ? this.data.toPlace.trim() : this.data.tradePlace.trim(),
          contact: this.data.contact.trim(),
          // 跑腿字段只在跑腿时带，闲置传 undefined 不会产生这个 key
          errandType: isErrand ? this.data.errandType : undefined,
          errandTypeName: isErrand ? this.data.errandTypeName : undefined,
          fromPlace: isErrand ? this.data.fromPlace.trim() : undefined,
          toPlace: isErrand ? this.data.toPlace.trim() : undefined,
          deadline: isErrand ? this.data.deadline : undefined
        },
        { silent: true }
      );

      wx.hideLoading();
      wx.showToast({ title: '发布成功', icon: 'success' });

      // 标记首页需要刷新。
      // 这里不能用 getCurrentPages() 去找首页实例再调它的方法：
      // tabBar 页面切换后 getCurrentPages() 只含当前页（实测在发布页里
      // 拿到的是 ["pages/publish/publish"]），找不到首页 → 标记静默失效 →
      // 发布成功但首页还是旧列表，用户点到旧卡片就会看到「商品不存在或已被删除」。
      app.markListRefresh();
      // 首页还要切到对应 tab，否则发了跑腿但首页还在「闲置」栏，看着像没发出去
      app.globalData.pendingIndexType = isErrand ? 'errand' : 'goods';

      this.resetForm();

      setTimeout(() => {
        wx.switchTab({ url: '/pages/index/index' });
      }, 1200);

    } catch (e) {
      wx.hideLoading();
      toast(e.message || '发布失败，请重试');
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 并发上传所有图片 */
  uploadAll(paths) {
    return Promise.all(paths.map(p => uploadImage(p, 'products')));
  },

  /**
   * 图片内容安全检测
   * 有违规图 → 删掉刚上传的文件并中断发布，避免违规内容进数据库
   *
   * 注意：图片上传是客户端直传云存储，不经过云函数，
   * 所以必须显式补上这一步，否则 imgSecCheck 永远不会被执行。
   */
  async checkImages(fileIDs) {
    // 跑腿可以不上图，空数组不要去调接口（省一次无意义的往返）
    if (!fileIDs || fileIDs.length === 0) return;

    let res;
    try {
      res = await call('upload', 'imgSecCheck', { fileIDs }, { silent: true });
    } catch (e) {
      // 检测服务异常不阻断发布，与云函数内的降级策略保持一致
      console.warn('[publish] 图片检测失败，跳过:', e && (e.msg || e.message));
      return;
    }

    if (res && res.pass === false) {
      try {
        await call('upload', 'deleteFiles', { fileIDs }, { silent: true });
      } catch (e) {
        console.warn('[publish] 清理违规图片失败:', e && (e.msg || e.message));
      }
      const n = (res.risky || []).length || fileIDs.length;
      throw new Error(`有 ${n} 张图片未通过内容安全检测，请更换后重试`);
    }
  },

  resetForm() {
    this.setData({
      images: [],
      title: '',
      desc: '',
      price: '',
      oriPrice: '',
      categoryId: '',
      categoryName: '',
      tradePlace: '',
      contact: '',
      errandType: '',
      errandTypeName: '',
      fromPlace: '',
      toPlace: ''
    });
  },

  /**
   * 返回首页。
   * 发布是 tabBar 页面，是 switchTab 进来的，页面栈里只有它自己
   * （实测 getCurrentPages() 返回 ["pages/publish/publish"]）——
   * 所以不能用 navigateBack（无上一页可退），只能 switchTab 回首页。
   */
  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  }
});
