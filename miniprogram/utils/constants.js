/**
 * utils/constants.js — 状态映射等常量
 *
 * 注意：分类、跑腿类型、学校名等可配置项已统一收到 miniprogram/config.js
 * 这里只放"映射表"这类不需要改的东西，避免两处维护
 *
 * 面交地点**不在这里**：已改为发布时用户自己打字描述（校园地点太多，
 * 预设选项永远不够用），见 pages/publish/publish.wxml「面交地点」那一项。
 */

const config = require('../config');

// 商品分类（来源：config.js）
const CATEGORIES = config.categories;

// 商品状态
const PRODUCT_STATUS = {
  ON_SALE: 'on_sale',
  SOLD: 'sold',
  OFF_SHELF: 'off_shelf',
  DELETED: 'deleted',
  BLOCKED: 'blocked'
};

const PRODUCT_STATUS_TEXT = {
  on_sale: '在售',
  sold: '已售出',
  off_shelf: '已下架',
  deleted: '已删除',
  blocked: '违规下架'
};

// 订单状态
const ORDER_STATUS = {
  PENDING: 'pending',
  TRADING: 'trading',
  DONE: 'done',
  CANCELED: 'canceled'
};

const ORDER_STATUS_TEXT = {
  pending: '待卖家确认',
  trading: '交易中',
  done: '已完成',
  canceled: '已取消'
};

// 认证状态
const VERIFY_STATUS_TEXT = {
  none: '未认证',
  pending: '审核中',
  passed: '已认证',
  rejected: '认证被驳回'
};

// 面交地点**没有**预设列表：已改为发布时用户自己打字描述（校园地点太多，
// 固定选项永远不够用），见 pages/publish/publish.wxml。

// 跑腿类型（来源：config.js）
const ERRAND_TYPES = config.errandTypes;

/**
 * 跑腿状态文案。
 * 与云函数里的 errandStatus 一一对应，**不要**复用 PRODUCT_STATUS_TEXT：
 * 同一个 on_sale，对闲置是「在售」，对跑腿是「待接单」，共用会让用户看懵。
 */
const ERRAND_STATUS_TEXT = {
  open: '待接单',
  taken: '进行中',
  done: '已完成',
  canceled: '已取消'
};

const ERRAND_STATUS_CLASS = {
  open: 'tag-green',
  taken: 'tag-orange',
  done: 'tag-gray',
  canceled: 'tag-red'
};

/** 首页/跑腿列表按 errandType 找图标 */
const ERRAND_TYPE_MAP = ERRAND_TYPES.reduce((acc, t) => {
  acc[t.id] = t;
  return acc;
}, {});

const CATEGORY_MAP = CATEGORIES.reduce((acc, c) => {
  acc[c.id] = c.name;
  return acc;
}, {});

module.exports = {
  CATEGORIES,
  CATEGORY_MAP,
  PRODUCT_STATUS,
  PRODUCT_STATUS_TEXT,
  ORDER_STATUS,
  ORDER_STATUS_TEXT,
  VERIFY_STATUS_TEXT,
  ERRAND_TYPES,
  ERRAND_TYPE_MAP,
  ERRAND_STATUS_TEXT,
  ERRAND_STATUS_CLASS
};
