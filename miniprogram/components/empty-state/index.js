Component({
  properties: {
    icon: { type: String, value: '📭' },
    text: { type: String, value: '暂无数据' },
    // 可选按钮
    btnText: { type: String, value: '' }
  },
  methods: {
    onBtnTap() {
      this.triggerEvent('btntap');
    }
  }
});
