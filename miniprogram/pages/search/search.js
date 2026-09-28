// pages/search/search.js
const { call } = require('../../utils/request');
const { debounce } = require('../../utils/util');

const PAGE_SIZE = 10;
const HISTORY_KEY = 'search_history';
const HISTORY_MAX = 10;

Page({
  data: {
    keyword: '',
    // goods（闲置）/ errand（跑腿）。从首页跑腿 tab 点搜索进来时自动带 errand
    searchType: 'goods',
    list: [],
    cursor: null,
    hasMore: true,
    loading: false,
    searched: false,
    history: []
  },

  onLoad(options) {
    this.setData({
      history: wx.getStorageSync(HISTORY_KEY) || [],
      searchType: options && options.type === 'errand' ? 'errand' : 'goods'
    });
    // 防抖搜索，避免每敲一个字就请求
    this.doSearchDebounced = debounce(() => this.search(true), 400);
  },

  // 闲置 / 跑腿切换：清空结果并按当前关键词重搜
  onTypeTap(e) {
    const t = e.currentTarget.dataset.type;
    if (!t || t === this.data.searchType) return;
    this.setData({ searchType: t, list: [], searched: false, hasMore: true, cursor: null });
    if (this.data.keyword.trim()) this.search(true);
  },

  onInput(e) {
    const keyword = e.detail.value;
    this.setData({ keyword });
    if (!keyword.trim()) {
      this.setData({ list: [], searched: false, hasMore: true, cursor: null });
      return;
    }
    this.doSearchDebounced();
  },

  onConfirm() {
    this.search(true);
  },

  onHistoryTap(e) {
    const kw = e.currentTarget.dataset.kw;
    this.setData({ keyword: kw });
    this.search(true);
  },

  clearHistory() {
    wx.showModal({
      title: '清空搜索历史',
      content: '确定要清空吗？',
      success: res => {
        if (!res.confirm) return;
        wx.removeStorageSync(HISTORY_KEY);
        this.setData({ history: [] });
      }
    });
  },

  saveHistory(keyword) {
    // 用 concat 而非数组展开：避免开发者工具 ES5 转译注入
    // @babel/runtime/helpers/arrayWithoutHoles 依赖（自动化/Worker 模式下该辅助模块缺失会报错）
    const rest = this.data.history.filter(k => k !== keyword);
    const history = [keyword].concat(rest).slice(0, HISTORY_MAX);
    wx.setStorageSync(HISTORY_KEY, history);
    this.setData({ history });
  },

  async search(reset = false) {
    const keyword = this.data.keyword.trim();
    if (!keyword) return;
    if (this.data.loading) return;
    if (!reset && !this.data.hasMore) return;

    this.setData({ loading: true });
    if (reset) this.saveHistory(keyword);

    try {
      const res = await call('product', 'list', {
        keyword,
        type: this.data.searchType,
        cursor: reset ? undefined : this.data.cursor || undefined,
        pageSize: PAGE_SIZE
      });

      this.setData({
        list: reset ? res.list : this.data.list.concat(res.list),
        cursor: res.nextCursor,
        hasMore: res.hasMore,
        loading: false,
        searched: true
      });
    } catch (e) {
      this.setData({ loading: false, searched: true });
    }
  },

  onReachBottom() {
    this.search(false);
  },

  onCardTap(e) {
    const id = e.detail && e.detail.id;
    // 防线：detail 为空时不跳转（详见 product-card 组件里的说明）
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  }
});
