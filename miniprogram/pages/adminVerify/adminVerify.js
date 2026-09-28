// pages/adminVerify/adminVerify.js — 认证审核
const { call } = require('../../utils/request');
const { formatTime, toast } = require('../../utils/util');

const PAGE_SIZE = 20;

const TABS = [
  { key: 'pending', label: '待审核' },
  { key: 'passed', label: '已通过' },
  { key: 'rejected', label: '已驳回' }
];

Page({
  data: {
    tabs: TABS,
    activeTab: 'pending',
    list: [],
    cursor: null,
    hasMore: true,
    loading: false,
    acting: false
  },

  onLoad() {
    this.loadList(true);
  },

  async loadList(reset = false) {
    if (this.data.loading) return;
    if (!reset && !this.data.hasMore) return;

    this.setData({ loading: true });

    try {
      const res = await call('admin', 'listVerifyRequests', {
        status: this.data.activeTab,
        cursor: reset ? undefined : this.data.cursor || undefined,
        pageSize: PAGE_SIZE
      });

      const list = (res.list || []).map(u => ({
        ...u,
        timeText: formatTime(u.updatedAt || u.createdAt)
      }));

      this.setData({
        list: reset ? list : this.data.list.concat(list),
        cursor: res.nextCursor,
        hasMore: res.hasMore,
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  onTabTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeTab) return;
    this.setData({ activeTab: key, list: [], cursor: null, hasMore: true });
    this.loadList(true);
  },

  /** 通过 */
  async onApprove(e) {
    const { id, name } = e.currentTarget.dataset;
    const confirm = await new Promise(resolve =>
      wx.showModal({
        title: '通过认证',
        content: `确认通过「${name}」的校园认证？`,
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    );
    if (!confirm) return;

    await this.doAudit(id, true, '');
  },

  /** 驳回 */
  async onReject(e) {
    const { id, name } = e.currentTarget.dataset;

    const res = await new Promise(resolve =>
      wx.showModal({
        title: '驳回认证',
        editable: true,
        placeholderText: '填写驳回原因（会展示给用户）',
        success: r => resolve(r),
        fail: () => resolve({ confirm: false })
      })
    );

    if (!res.confirm) return;

    await this.doAudit(id, false, res.content || '信息不完整，请重新提交');
  },

  async doAudit(targetUserId, pass, reason) {
    if (this.data.acting) return;
    this.setData({ acting: true });

    try {
      await call('admin', 'auditVerify', { targetUserId, pass, reason });
      toast(pass ? '已通过' : '已驳回');
      this.loadList(true);
    } catch (e) {
      // 错误已提示
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 复制学号（方便去教务系统核对） */
  copyStudentNo(e) {
    const { no } = e.currentTarget.dataset;
    if (!no) return;
    wx.setClipboardData({
      data: no,
      success: () => toast('学号已复制')
    });
  },

  onReachBottom() {
    this.loadList(false);
  },

  onPullDownRefresh() {
    this.setData({ cursor: null, hasMore: true });
    this.loadList(true).then(() => wx.stopPullDownRefresh());
  }
});
