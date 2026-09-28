/**
 * config.js — 全局配置（只改这一个文件）
 *
 * 部署前必须改的两项：
 *   1. envId      云开发环境 ID
 *   2. school     你的学校名
 *
 * 其他按需改。
 */

module.exports = {
  /* ============ 必改 ============ */

  // 云开发环境 ID。云开发控制台 → 设置 → 环境 ID
  // 形如 'cloud1-8gxxxxxx'，不填小程序会白屏
  envId: 'cloud1-d1gi2hlj2b3d6399d',

  // 学校全称。用于同校过滤和认证，务必所有用户填一致
  school: '广西生态工程职业技术学院',

  /* ============ 建议改 ============ */

  // 注：面交地点**没有**预设选项——校园里的地点太多，固定列表永远不够用，
  // 发布页已改成让用户自己打字描述（pages/publish/publish.wxml 的「面交地点」）。

  // 商品分类
  categories: [
    { id: 'book', name: '教材书籍' },
    { id: 'digital', name: '数码电子' },
    { id: 'daily', name: '生活用品' },
    { id: 'clothes', name: '服饰鞋包' },
    { id: 'sports', name: '运动户外' },
    { id: 'beauty', name: '美妆护肤' },
    { id: 'food', name: '零食饮料' },
    { id: 'other', name: '其他' }
  ],

  // 校园跑腿类型
  // 注意：id 必须与 cloudfunctions/product/index.js 里的 ERRAND_TYPES 白名单一致，
  // 否则发任务时会被云函数判为「参数格式错误」。
  errandTypes: [
    { id: 'express', name: '代取快递', icon: '📦' },
    { id: 'buy', name: '代买代购', icon: '🛒' },
    { id: 'deliver', name: '代送物品', icon: '🚲' },
    { id: 'queue', name: '代排队', icon: '⏳' },
    { id: 'other', name: '其他跑腿', icon: '🏃' }
  ],

  /* ============ 可选 ============ */

  // 首页顶部提示文案
  notice: {
    text: '同校交易 · 面交更放心',
    sub: '只显示本校同学的闲置'
  },

  // 联系方式 —— 「我的 → 意见反馈」里展示给用户。
  // 至少填一项，否则用户想反馈也找不到人。留空的那项不会显示。
  contact: {
    wechat: 'qz11072024',   // 管理员微信号（2026-09-28 由用户提供）
    qq: '',
    email: ''     // 建议用学校邮箱
  },

  // 管理后台入口：**无需在此配置**
  //
  // 真实机制（见 cloudfunctions/admin/index.js）：管理员名单存放在数据库
  // config 集合的 _id='admin' 文档里，字段名 openids。数据库里还没有这个文档时，
  // 「我的」页面第一次调用 admin/checkAdmin 的那个用户会自动自举成为管理员，
  // 所以部署完直接用微信登录就能进后台，不用手动填任何东西。
  //
  // 想加别的管理员：云开发控制台 → 数据库 → config → 打开 _id='admin' 的文档，
  // 往 openids 数组里追加对方的 _openid 即可（改完即时生效，不用重新部署）。
  //
  // 下面这个字段保留仅为兼容旧配置，当前代码不读取它。
  adminOpenids: [
    // 'oXXXXXXXXXXXXXXXXXXXXXXXXXXX'
  ]
};
