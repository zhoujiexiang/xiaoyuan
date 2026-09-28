/**
 * components/product-card — 内容卡片
 * 用于：首页列表（闲置/跑腿）、搜索结果、我的发布、收藏列表、对方主页
 *
 * 一个卡片同时承担「二手闲置」和「校园跑腿」两种内容的展示，
 * 靠 item.type 分支。之所以不拆成两个组件：两边的骨架完全一样，
 * 只有图片占位、地点行、价格前缀、状态文案四处不同。
 */
const { formatPrice, formatTime, formatDeadline } = require('../../utils/util');
const {
  PRODUCT_STATUS_TEXT,
  ERRAND_STATUS_TEXT,
  ERRAND_STATUS_CLASS,
  ERRAND_TYPE_MAP
} = require('../../utils/constants');

Component({
  properties: {
    item: { type: Object, value: {} },
    // 是否展示卖家信息（收藏页不需要）
    showSeller: { type: Boolean, value: true },
    // 是否展示状态角标（我的发布需要）
    showStatus: { type: Boolean, value: false }
  },

  data: {
    isErrand: false,
    priceText: '0',
    timeText: '',
    deadlineText: '',
    errandIcon: '🏃',
    statusText: '',
    statusClass: ''
  },

  observers: {
    'item': function (item) {
      if (!item || !item._id) return;

      const isErrand = item.type === 'errand';
      const type = ERRAND_TYPE_MAP[item.errandType];

      this.setData({
        isErrand,
        priceText: formatPrice(item.price),
        timeText: formatTime(item.createdAt),
        // 截止时间是**未来**时间，必须用 formatDeadline ——
        // 用 formatTime 会永远显示「截止 刚刚」（那个函数是过去时间语义）
        deadlineText: item.deadline ? `截止 ${formatDeadline(item.deadline, true)}` : '',
        errandIcon: (type && type.icon) || '🏃',
        // 同一个 on_sale，闲置叫「在售」、跑腿叫「待接单」，不能共用一张表
        statusText: isErrand
          ? (ERRAND_STATUS_TEXT[item.errandStatus] || '待接单')
          : (PRODUCT_STATUS_TEXT[item.status] || ''),
        statusClass: isErrand
          ? (ERRAND_STATUS_CLASS[item.errandStatus] || 'tag-green')
          : this.getStatusClass(item.status)
      });
    }
  },

  methods: {
    getStatusClass(status) {
      if (status === 'sold') return 'tag-gray';
      if (status === 'off_shelf' || status === 'deleted' || status === 'blocked') return 'tag-red';
      return 'tag-green';
    },

    onTap() {
      const id = this.data.item && this.data.item._id;
      // 没有 id 的卡片（理论上不该出现）不发事件，避免父页面拿到 undefined 去跳详情
      if (!id) {
        console.warn('[product-card] 卡片缺少 _id，已忽略点击', this.data.item);
        return;
      }
      // 事件名**不能**用内置事件名（tap / longpress 等）：
      // 与内置名同名时，父页面 bind:tap 会同时收到「自定义事件」和「原生冒泡事件」，
      // 后者 detail 为空 → 跳转到 ?id=undefined。历史 bug，改用 cardtap。
      this.triggerEvent('cardtap', { id });
    },

    /**
     * 点卖家行 → 进对方主页（可以在那里发消息私聊）
     * 同样不能叫 tap。父页面用 bind:sellertap 接。
     */
    onSellerTap() {
      const item = this.data.item || {};
      if (!item.sellerId) {
        // 老数据可能没有 sellerId，宁可不跳也不跳到一个坏页面
        console.warn('[product-card] 卡片缺少 sellerId，已忽略卖家点击', item._id);
        return;
      }
      this.triggerEvent('sellertap', {
        sellerId: item.sellerId,
        sellerName: item.sellerName || '',
        sellerAvatar: item.sellerAvatar || ''
      });
    }
  }
});
