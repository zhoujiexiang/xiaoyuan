# 校园二手交易小程序

基于**微信云开发**的校园闲置交易平台。无需服务器、无需自建数据库，云函数 + 云数据库 + 云存储一站式搞定。

> **只想跑起来** → 看 [`开始使用.md`](./开始使用.md)，只需 3 步。
> **想了解设计** → 继续往下读。

---

## 目录结构

```
campus-market/
├── 开始使用.md                     ★ 三步跑起来
├── README.md                       技术选型与设计决策
│
├── miniprogram/                    小程序端
│   ├── config.js                   ★ 全局配置（只改这一个文件）
│   ├── app.js                      入口：云开发初始化、登录态、管理员判断
│   ├── app.json                    页面注册 + tabBar
│   ├── app.wxss                    全局样式
│   ├── utils/
│   │   ├── request.js              云函数调用统一封装
│   │   ├── util.js                 时间/价格格式化、防抖节流
│   │   └── constants.js            状态映射表
│   ├── components/
│   │   ├── product-card/           商品卡片（列表复用）
│   │   └── empty-state/            空状态
│   └── pages/
│       ├── index/                  首页：商品列表 + 分类筛选
│       ├── search/                 搜索：关键词 + 历史记录
│       ├── publish/                发布：传图 + 表单
│       ├── detail/                 商品详情：图片轮播、卖家信息、下单
│       ├── message/                会话列表
│       ├── chat/                   聊天（watch 实时监听）
│       ├── mine/                   我的：统计、入口
│       ├── login/                  微信一键登录（不再申请头像昵称）
│       ├── profile/                编辑资料：chooseAvatar + nickname
│       ├── verify/                 校园认证
│       ├── myProducts/             我的发布
│       ├── myOrders/               我的订单（买家/卖家）
│       ├── favorites/              我的收藏
│       ├── admin/                  ★ 管理后台首页
│       ├── adminVerify/            ★ 认证审核
│       ├── adminReports/           ★ 举报处理
│       └── adminProducts/          ★ 商品管理
│
├── cloudfunctions/                 云函数（7 个）
│   ├── user/                       登录、认证、个人资料
│   ├── product/                    发布、列表、详情、上下架、收藏、举报
│   ├── order/                      下单、状态流转、列表、详情
│   ├── message/                    发送、聊天记录、会话列表
│   ├── upload/                     临时链接、删文件、图片检测
│   ├── admin/                      ★ 管理端：审核、举报、封禁
│   └── init/                       ★ 一键创建集合与索引
│
└── docs/
    ├── 00-初始化指南.md            详细的 10 步部署 + 排查
    ├── 01-数据库设计.md            6 张集合的字段、索引、权限
    ├── 02-接口设计.md              接口的入参出参、错误码
    └── 03-数据库权限规则.json      权限规则配置（按集合拆分）
```

---

## 改了接口就跑一下契约核对

```bash
node tools/check-api-contract.js
```

它会比对「前端 `call()` 传出去的字段」和「云函数 handler 实际读的字段」，报出：

- **死参数** —— 前端传了但云函数从不读（典型是业务参数命名成 `action`，把分发键顶掉了）
- **缺必填参数** —— handler 里有 `if (!x) throw` 校验、前端却没传
- **无此动作** —— 前端调的动作，云函数里没有对应 `case`

为什么需要它：这类问题**编译器不报、运行时也不抛错**，功能直接静默失效。
（`offShelf` / `updateStatus` / `handleReport` / `blockProduct` / `banUser`
五处就因为这个原因全部失效过。）

## 端到端测试（真实模拟器）

`tools/e2e-test.cjs` 在真实模拟器里跑完整链路：全部页面渲染 → 7 个云函数契约
→ 下架/重新上架真实点击 → 头像昵称与图片内容安全真实链路 → 分享
→ 订单/消息/举报守卫 → 管理端只读接口 → 数据清理与复核。

```bash
# 1) 关窗口 → 开自动化（端口要在 Windows 保留段之外，并先 close 才生效）
cd "<微信开发者工具安装目录>"
./cli.bat close --project "<项目路径>"
./cli.bat auto  --project "<项目路径>" --auto-port 9700
sleep 10

# 2) 紧接着跑（客户端一断开，自动化服务就被 IDE 回收）
NODE_PATH="<node_modules>" node tools/e2e-test.cjs 9700
```

上面两步已经包成一条命令：

```bash
bash tools/run-e2e.sh            # 默认端口 9700
bash tools/run-e2e.sh 9800       # 换端口（9700 被占时）
```


测试会临时写入数据（认证状态、测试商品），**跑完自动清理并复核**。
最近一次结果见 `docs/测试报告-2026-09-17.md`（38/38 通过）。

---

## 技术选型

| 层 | 选型 | 为什么 |
|---|---|---|
| 小程序端 | 原生开发 | 不需要框架，页面少，原生最直接 |
| 后端 | 云函数（5 个模块） | 不用买服务器、不用配 Nginx、不用管 HTTPS |
| 数据库 | 云开发文档数据库 | 自带，免运维 |
| 图片存储 | 云存储 | 客户端直传，不走云函数 |
| 聊天 | `db.watch()` 实时监听 | 比轮询省资源，代码量差不多 |
| 支付 | **不做** | 校园二手多为面交，先跑通流程 |

### 关于「不做支付」

原始方案里说「先不做支付」，我保留了。理由是：
1. 微信支付需要**企业主体 + 商户号**，个人开发者申请不下来
2. 校园二手 90% 是面交，「线上下单 + 线下付款」完全能用
3. 等真的要做了，加一个 `pay` 云函数接 `cloudPay.unifiedOrder` 即可，不影响现有结构

---

## 核心设计决策

### 1. openid 永远从服务端取

```js
const { OPENID } = cloud.getWXContext();   // ✅ 可信
const openid = event.openid;               // ❌ 客户端伪造
```

所有云函数都遵循这条。客户端传上来的 `openid` 一律不用。

### 2. 写操作走云函数，读操作能直连就直连

| 集合 | 读取 | 写入 |
|---|---|---|
| `products` | 客户端直读（`read: true`） | 云函数 |
| `favorites` | 客户端直读 | 客户端直写 |
| `users` | 仅自己 | 云函数 |
| `orders` | 买卖双方 | 云函数 |
| `messages` | 收发双方 | 云函数 |

商品列表直读数据库，省下每次翻页的云函数调用。订单和消息涉及状态和金额，必须服务端校验。

### 3. 状态机在服务端

订单状态流转由 `cloudfunctions/order/index.js` 的 `TRANSITIONS` 表控制：

```js
const TRANSITIONS = {
  accept:   { from: ['pending'],          to: 'trading',  role: 'seller' },
  reject:   { from: ['pending'],          to: 'canceled', role: 'seller' },
  cancel:   { from: ['pending','trading'],to: 'canceled', role: 'both'   },
  complete: { from: ['trading'],          to: 'done',     role: 'both'   }
};
```

前端只传 `action`，能不能做由服务端判断。**否则用户能把 `done` 改回 `pending` 刷单。**

### 4. 冗余换性能

商品里存 `sellerName` / `sellerAvatar` / `categoryName`，订单里存 `productSnapshot`，消息里存 `fromId` / `toId`。

理由：列表页不联表，订单页在商品被删后仍能正常显示。

### 5. 先检测后入库

发布流程严格按顺序：

```
参数校验 → 本地违禁词 → 微信内容安全 → 写数据库
```

违规内容不写库，避免出现「已发布」的窗口期。

### 6. 游标分页而非 skip

```js
where.createdAt = _.lt(new Date(cursor));   // ✅ 每页耗时恒定
query.skip(1000).limit(10);                 // ❌ 越翻越慢
```

多取 1 条判断 `hasMore`，省掉一次 `count()` 查询。

---

## 已知技术债（诚实记录）

| 问题 | 影响 | 什么时候必须解决 |
|---|---|---|
| 下单时并发检查有窗口 | 两人可能同时下单成功 | 并发量上来后，加唯一索引或分布式锁 |
| 搜索用正则匹配 | 数据量上万后变慢 | 换云开发全文检索，或接搜索服务 |
| 会话列表限 50 条 | 会话超过 50 个会截断 | 加游标分页 |
| 索引需手动建 | 数据量大后列表变慢 | 按 `开始使用.md` 的清单建一次即可 |
| 管理后台无操作日志 | 管理员操作不可追溯 | 多人管理时加 `admin_logs` 集合 |

---

## 配置集中在一处

所有需要改的东西都在 **`miniprogram/config.js`**：

```js
envId          云开发环境 ID（必改）
school         学校名（必改）
categories     商品分类
notice         首页提示文案
adminOpenids   早期遗留字段，当前代码不读取（管理员名单以数据库 config/admin 文档为准）
```

> 面交地点**没有**配置项：校园地点太多，固定列表永远不够用，发布时由用户自己打字描述。


> 早期版本学校名散落在 `login.js` 和 `verify.js` 里，用户要改三处还容易改不一致
> ——一旦不一致，同校过滤就失效了。现在统一从 config 读，也去掉了让用户手选学校的步骤。

---

## 上线前必读

**二手交易类目需要企业主体 + 资质**，个人主体小程序上不了这个类目。

如果只是课设 / 练手：
- 用「工具」类目，限制本校使用
- 或只提交体验版，不发布上线

**建议提前确认，别等代码写完了发现上不了线。**
