/**
 * utils/util.js — 通用工具函数
 */

/** 格式化时间：刚刚 / 5分钟前 / 今天 12:30 / 9月16日 / 2025年9月16日 */
function formatTime(input) {
  if (!input) return '';
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 24 * 60 * 60 * 1000) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * 格式化「未来的截止时间」：今天 18:00 / 明天 12:30 / 9月20日 18:00 / 已截止
 *
 * ⚠️ **不能用 formatTime 代替**：那个是「过去时间」语义（`diff = now - date`），
 * 喂未来时间时 diff 为负，会一路落进第一个分支、永远返回「刚刚」。
 * 真实后果（2026-09-18 发现）：跑腿卡片的截止时间全部显示「截止 刚刚」，
 * 详情页显示「刚刚 前」—— 用户根本看不出任务什么时候到期。
 *
 * @param {*} input 时间戳 / Date / ISO 字符串
 * @param {boolean} short 卡片用：跨天时只到「日」（卡片右下角空间有限）
 */
function formatDeadline(input, short) {
  if (!input) return '';
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  if (date.getTime() <= now.getTime()) return '已截止';

  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((dayStart(date) - dayStart(now)) / 86400000);

  if (dayDiff === 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `明天 ${hm}`;
  const md = `${date.getMonth() + 1}月${date.getDate()}日`;
  if (date.getFullYear() !== now.getFullYear()) {
    return `${date.getFullYear()}年${md}${short ? '' : ' ' + hm}`;
  }
  return short ? md : `${md} ${hm}`;
}

/** 聊天气泡用的精确时间 */
function formatChatTime(input) {
  if (!input) return '';
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (isToday) return hm;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 价格展示，去掉无意义的小数（12.00 → 12） */
function formatPrice(price) {
  const n = Number(price);
  if (isNaN(n)) return '0';
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

/** 手机号中间打码 */
function maskPhone(phone) {
  if (!phone || phone.length < 7) return phone || '';
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

/** 节流 */
function throttle(fn, wait = 500) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last < wait) return;
    last = now;
    return fn.apply(this, args);
  };
}

/** 防抖 */
function debounce(fn, wait = 300) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/** 轻提示 */
function toast(title, icon = 'none') {
  wx.showToast({ title, icon, duration: 2000 });
}

module.exports = {
  formatTime,
  formatDeadline,
  formatChatTime,
  formatPrice,
  maskPhone,
  throttle,
  debounce,
  toast,
  pad
};
