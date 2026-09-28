/**
 * 云函数 product — 商品与跑腿模块
 * actions:
 *   二手闲置：publish / list / detail / offShelf / remove / myList
 *             toggleFavorite / myFavorites / report
 *   校园跑腿：errandAccept / errandFinish / errandAbandon / errandCancel / errandMyList
 *
 * 闲置和跑腿共用 products 集合，靠 type 字段区分（老数据没有该字段 = 闲置）。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

const products = db.collection('products');
const users = db.collection('users');
const favorites = db.collection('favorites');
const orders = db.collection('orders');
const reports = db.collection('reports');

/* ---------- 响应 ---------- */
const ok = data => ({ code: 0, msg: 'ok', data: data || null });
const fail = (code, msg) => ({ code, msg, data: null });

/**
 * 判断错误是否为「集合不存在」
 * 未跑初始化时最容易撞到，要给用户明确指引而不是笼统的「服务异常」
 */
function isCollectionMissing(e) {
  const msg = String((e && (e.errMsg || e.message)) || '');
  return (
    (e && e.errCode === -502005) ||
    msg.includes('collection not exists') ||
    msg.includes('collection does not exist') ||
    msg.includes('DATABASE_COLLECTION_NOT_EXIST')
  );
}


const E = {
  PARAM: [40001, '参数缺失'],
  FORMAT: [40002, '参数格式错误'],
  TOO_LONG: [40003, '内容过长'],
  NOT_ERRAND: [40005, '这不是一条跑腿任务'],
  DEADLINE_PAST: [40006, '期望完成时间必须晚于现在'],
  NOT_LOGIN: [40101, '未登录'],
  BANNED: [40102, '账号已被封禁'],
  NOT_VERIFIED: [40103, '请先完成校园认证'],
  NO_PERM: [40201, '无权操作'],
  ONGOING_ORDER: [40307, '有进行中的订单，暂时无法操作'],
  BLOCKED: [40309, '该商品已被平台下架，无法自行上架'],
  ERRAND_SELF: [40310, '不能接自己发布的任务'],
  ERRAND_TAKEN: [40311, '手慢了，该任务已被其他同学接走'],
  ERRAND_STATE: [40312, '任务当前状态不支持这个操作'],
  NOT_FOUND: [40401, '商品不存在或已被删除'],
  RISKY: [40501, '内容包含违规信息，请修改后重试'],
  SERVER: [50000, '服务异常，请稍后重试']
};

const MAX_IMAGES = 9;
// 地点文本上限（面交地点 / 取件地 / 送达地），与前端 input 的 maxlength 对齐
const PLACE_MAX = 30;
const MAX_PAGE_SIZE = 20;
const DEFAULT_PAGE_SIZE = 10;

/* ---------- 内容类型 ----------
 * goods  = 二手闲置（默认，老数据没有 type 字段也按这个处理）
 * errand = 校园跑腿
 * 两种内容放在同一个 products 集合里，是为了复用列表/详情/搜索/收藏/举报/聊天
 * 这些已经写好并测过的东西，只在有几个差异的地方分支。
 */
const TYPE_ERRAND = 'errand';

// 跑腿类型白名单（前端 config.js 的 errandTypes 要与之保持一致）
const ERRAND_TYPES = ['express', 'buy', 'deliver', 'queue', 'other'];

// 违禁品关键词黑名单（先跑起来，后续可做成数据库配置）
const BANNED_WORDS = [
  '代写', '代考', '枪手', '答案出售',
  '香烟', '电子烟', '酒', '啤酒', '白酒',
  '处方药', '管制刀具', '仿真枪', '警用',
  '身份证', '学生证出售', '银行卡', '手机卡',
  '微信号出售', '账号出售', '代购处方'
];

/* ---------- 工具 ---------- */

async function requireUser(openid) {
  const res = await users.where({ _openid: openid }).limit(1).get();
  const user = res.data[0];
  if (!user) throw E.NOT_LOGIN;
  if (user.status === 'banned') throw E.BANNED;
  return user;
}

async function requireVerified(openid) {
  const user = await requireUser(openid);
  if (user.verifyStatus !== 'passed') throw E.NOT_VERIFIED;
  return user;
}

/**
 * 取当前用户，但允许「还没注册」。
 *
 * 浏览类接口（列表 / 详情）不该因为用户没登录就整体失败：
 * 用户点了「退出登录」之后总要能继续逛，否则「退出」看起来就像把小程序弄坏了。
 * 注意只放宽「不存在」这一种情况 —— 被封禁的账号仍然拒绝。
 */
async function getOptionalUser(openid) {
  const res = await users.where({ _openid: openid }).limit(1).get();
  const user = res.data[0] || null;
  if (user && user.status === 'banned') throw E.BANNED;
  return user;
}

/** 本地违禁词检测（快、免费，先挡一层） */
function checkBannedWords(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  for (const w of BANNED_WORDS) {
    if (lower.includes(w)) return w;
  }
  return null;
}

/**
 * 微信内容安全检测（文本）
 * 注意：这个接口有调用频率限制，异常时降级放行，不阻断正常用户
 */
async function msgSecCheck(content, openid) {
  if (!content) return 'pass';
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: content.slice(0, 2500),
      version: 2,
      scene: 2,          // 2 = 论坛/评论场景
      openid
    });
    // v2 版本返回 result.suggest
    const suggest = res && res.result && res.result.suggest;
    return suggest === 'risky' ? 'risky' : 'pass';
  } catch (e) {
    // 接口报错时不阻断业务流程，记录日志人工复查
    console.error('[msgSecCheck] failed:', e.errCode || e.message);
    return 'pass';
  }
}

/** 组装列表返回字段，减少传输体积 */
function pickListItem(p) {
  return {
    _id: p._id,
    // 必须带上 type：卡片要据此决定显示商品样式还是跑腿样式。
    // 漏掉它的症状是——跑腿任务在收藏列表里长得像二手商品（显示「¥5」而不是「酬劳 ¥5」）。
    type: p.type || 'goods',
    title: p.title,
    price: p.price,
    oriPrice: p.oriPrice || 0,
    cover: p.cover,
    tradePlace: p.tradePlace,
    categoryName: p.categoryName,
    status: p.status,
    // 跑腿专属
    errandStatus: p.errandStatus || '',
    errandTypeName: p.errandTypeName || '',
    fromPlace: p.fromPlace || '',
    toPlace: p.toPlace || '',
    deadline: p.deadline || null,
    runnerName: p.runnerName || '',
    viewCount: p.viewCount || 0,
    sellerId: p.sellerId,
    sellerName: p.sellerName,
    sellerAvatar: p.sellerAvatar,
    createdAt: p.createdAt
  };
}

/* ---------- actions ---------- */

/**
 * 发布（二手闲置 / 校园跑腿，同一个接口按 type 分支）
 * 顺序：校验 → 内容安全 → 入库
 *
 * 跑腿和闲置的差异只有三处，其余全复用：
 *   1. 必填字段不同（跑腿要类型/取件地/送达地/截止时间，不要分类和面交地点）
 *   2. 图片可选（跑腿经常没图，闲置必须至少有 1 张）
 *   3. 落库时多几个 errand* 字段
 */
async function publish(event, openid) {
  const {
    type, title, desc, price, oriPrice, images,
    categoryId, categoryName, tradePlace, contact,
    errandType, errandTypeName, fromPlace, toPlace, deadline
  } = event;

  const isErrand = type === TYPE_ERRAND;

  // 1. 参数校验
  if (!title || !desc || price === undefined) throw E.PARAM;

  const t = String(title).trim();
  const d = String(desc).trim();
  const imgs = Array.isArray(images) ? images : [];

  // 地点类字段都是**用户自由输入**的文本（面交地点自 2026-09-18 起不再有预设
  // 白名单，取件地/送达地一直是手打），所以这里必须自己把关：
  //   ① 纯空格等于没填 —— 前端会 trim，但云函数可以被直接调用绕过前端；
  //   ② 过长文本会把详情页 / 列表卡片排版撑破（前端 maxlength=30，这里对齐）。
  const normPlace = v => String(v || '').trim();
  const place = normPlace(tradePlace);
  const from = normPlace(fromPlace);
  const to = normPlace(toPlace);

  if (!t || !d) throw E.PARAM;
  if (t.length > 30) throw E.TOO_LONG;
  if (d.length > 500) throw E.TOO_LONG;
  if (place.length > PLACE_MAX || from.length > PLACE_MAX || to.length > PLACE_MAX) {
    throw E.TOO_LONG;
  }
  if (imgs.length > MAX_IMAGES) throw E.FORMAT;

  if (isErrand) {
    if (!errandType || !from || !to || !deadline) throw E.PARAM;
    if (!ERRAND_TYPES.includes(errandType)) throw E.FORMAT;
  } else {
    if (!categoryId || !place) throw E.PARAM;
    // 闲置换商品必须有图，跑腿可以有也可以没有
    if (imgs.length === 0) throw E.PARAM;
  }

  const p = Number(price);
  if (isNaN(p) || p <= 0) throw E.FORMAT;
  if (p > 99999) throw E.FORMAT;

  let deadlineDate = null;
  if (isErrand) {
    deadlineDate = new Date(deadline);
    if (isNaN(deadlineDate.getTime())) throw E.FORMAT;
    // 过去的截止时间没有意义，直接拦掉（顺带防一下客户端时钟不对）
    if (deadlineDate.getTime() < Date.now()) throw E.DEADLINE_PAST;
  }

  // 2. 认证校验
  const user = await requireVerified(openid);

  // 3. 本地黑名单
  // 地点文本同样是用户可见的发布内容（详情页 + 列表卡片），一起过一遍
  const hitWord = checkBannedWords(t) || checkBannedWords(d) || checkBannedWords(place);
  if (hitWord) {
    console.warn('[publish] banned word:', hitWord, 'user:', user._id);
    throw E.RISKY;
  }

  // 4. 微信内容安全
  const auditResult = await msgSecCheck(`${t}\n${d}\n${place}\n${from}\n${to}`, openid);
  if (auditResult === 'risky') throw E.RISKY;

  // 5. 入库
  const now = new Date();
  const doc = {
    _openid: openid,
    type: isErrand ? TYPE_ERRAND : 'goods',
    sellerId: user._id,
    sellerName: user.nickName,
    sellerAvatar: user.avatarUrl,
    title: t,
    desc: d,
    price: Number(p.toFixed(2)),
    oriPrice: isErrand ? 0 : (oriPrice ? Number(Number(oriPrice).toFixed(2)) : 0),
    images: imgs,
    cover: imgs[0] || '',
    // 跑腿统一挂到「校园跑腿」分类，免得首页分类筛选把任务漏掉
    categoryId: isErrand ? 'errand' : categoryId,
    categoryName: isErrand ? '校园跑腿' : (categoryName || ''),
    // 列表卡片上那个 📍 显示的是送达地点，对跑腿来说这才是有用的信息
    tradePlace: isErrand ? to : place,
    contact: contact || '',
    schoolId: user.schoolId || '',
    status: 'on_sale',
    viewCount: 0,
    favCount: 0,
    auditResult,
    createdAt: now,
    updatedAt: now
  };

  if (isErrand) {
    doc.errandType = errandType;
    doc.errandTypeName = errandTypeName || '';
    doc.fromPlace = from;
    doc.toPlace = to;
    doc.deadline = deadlineDate;
    // open=待接单 taken=进行中 done=已完成 canceled=已取消
    doc.errandStatus = 'open';
    doc.runnerId = '';
    doc.runnerName = '';
    doc.runnerAvatar = '';
    doc.runnerOpenid = '';
    doc.takenAt = null;
    doc.doneAt = null;
  }

  const res = await products.add({ data: doc });

  return ok({ productId: res._id, type: doc.type });
}

/**
 * 商品列表（游标分页）
 */
async function list(event, openid) {
  const {
    type, categoryId, keyword, sort = 'new',
    cursor, pageSize = DEFAULT_PAGE_SIZE
  } = event;

  const size = Math.min(Number(pageSize) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const where = { status: 'on_sale' };

  // 内容类型：goods（二手闲置，默认）/ errand（校园跑腿）
  // 老数据没有 type 字段，所以「闲置」这侧要用 neq('errand') 而不是 eq('goods')，
  // 否则改造前发布的商品会集体从列表里消失。
  if (type === 'errand') {
    where.type = 'errand';
  } else {
    where.type = _.neq('errand');
  }

  // 同校过滤。用户没登录/已退出登录时退化为「不过滤学校」，保证还能浏览。
  const user = await getOptionalUser(openid);
  if (user && user.schoolId) where.schoolId = user.schoolId;

  if (categoryId) where.categoryId = categoryId;

  if (keyword && String(keyword).trim()) {
    // 转义正则特殊字符，避免用户输入 ( [ 等导致报错
    const safe = String(keyword).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    where.title = db.RegExp({ regexp: safe, options: 'i' });
  }

  // 游标分页
  if (cursor) {
    where.createdAt = _.lt(new Date(cursor));
  }

  let query = products.where(where);

  if (sort === 'price_asc') query = query.orderBy('price', 'asc').orderBy('createdAt', 'desc');
  else if (sort === 'price_desc') query = query.orderBy('price', 'desc').orderBy('createdAt', 'desc');
  else query = query.orderBy('createdAt', 'desc');

  // 多取 1 条判断 hasMore
  const res = await query.limit(size + 1).get();

  const hasMore = res.data.length > size;
  const rows = hasMore ? res.data.slice(0, size) : res.data;

  return ok({
    list: rows.map(pickListItem),
    hasMore,
    nextCursor: rows.length ? rows[rows.length - 1].createdAt : null
  });
}

/**
 * 商品详情
 */
async function detail(event, openid) {
  const { productId } = event;
  if (!productId) throw E.PARAM;

  let product;
  try {
    const res = await products.doc(productId).get();
    product = res.data;
  } catch (e) {
    // 只有「文档不存在 / id 非法」才算 404。
    // 这里原来是无条件 `throw E.NOT_FOUND`，会把权限、网络等真实故障
    // 也报成「商品不存在或已被删除」，前端和用户都会被误导。
    const msg = String((e && (e.errMsg || e.message)) || '');
    const notExists =
      (e && (e.errCode === -502001 || e.errCode === -502002)) ||
      /not exist|does not exist|DOCUMENT_NOT_EXIST|invalid\s+(id|document)/i.test(msg);
    if (notExists) throw E.NOT_FOUND;
    throw e;
  }

  if (!product || product.status === 'deleted') throw E.NOT_FOUND;

  // 浏览量自增（原子操作）
  products
    .doc(productId)
    .update({ data: { viewCount: _.inc(1) } })
    .catch(e => console.error('[viewCount] failed:', e));

  const user = await getOptionalUser(openid);

  // 卖家信息
  let seller = {
    _id: product.sellerId,
    nickName: product.sellerName,
    avatarUrl: product.sellerAvatar,
    creditScore: 100,
    verifyStatus: 'none'
  };

  try {
    const sellerRes = await users.doc(product.sellerId).get();
    if (sellerRes.data) {
      const s = sellerRes.data;
      seller = {
        _id: s._id,
        nickName: s.nickName,
        avatarUrl: s.avatarUrl,
        creditScore: s.creditScore,
        verifyStatus: s.verifyStatus
      };
    }
  } catch (e) {
    // 卖家账号可能已删除，用冗余信息兜底
  }

  // 是否已收藏（未登录时恒为 false，不发这次查询）
  let isFavorited = false;
  if (user) {
    const favRes = await favorites
      .where({ userId: user._id, productId })
      .limit(1)
      .get();
    isFavorited = favRes.data.length > 0;
  }

  return ok({
    product: { ...product, viewCount: (product.viewCount || 0) + 1 },
    seller,
    isFavorited,
    isOwner: !!user && product.sellerId === user._id
  });
}

/**
 * 上下架
 */
async function offShelf(event, openid) {
  // 业务动作字段名必须是 op，不能用 action —— action 是 main 里的分发键，
  // 前端传 action 会把分发键顶掉，请求根本进不来
  const { productId, op } = event;
  if (!productId) throw E.PARAM;
  if (!['on', 'off'].includes(op)) throw E.PARAM;

  const user = await requireUser(openid);

  const res = await products.doc(productId).get().catch(() => null);
  const product = res && res.data;
  if (!product || product.status === 'deleted') throw E.NOT_FOUND;

  if (product.sellerId !== user._id) throw E.NO_PERM;

  // 被管理员强制下架的商品，卖家不能自己重新上架，否则封禁形同虚设
  if (product.status === 'blocked') throw E.BLOCKED;

  // 有进行中订单时不允许下架
  const ongoing = await orders
    .where({
      productId,
      status: _.in(['pending', 'trading'])
    })
    .limit(1)
    .get();

  if (ongoing.data.length > 0) throw E.ONGOING_ORDER;

  const status = op === 'on' ? 'on_sale' : 'off_shelf';

  await products.doc(productId).update({
    data: { status, updatedAt: new Date() }
  });

  return ok({ status });
}

/**
 * 删除（逻辑删除）
 */
async function remove(event, openid) {
  const { productId } = event;
  if (!productId) throw E.PARAM;

  const user = await requireUser(openid);

  const res = await products.doc(productId).get().catch(() => null);
  const product = res && res.data;
  if (!product || product.status === 'deleted') throw E.NOT_FOUND;

  if (product.sellerId !== user._id) throw E.NO_PERM;

  const ongoing = await orders
    .where({ productId, status: _.in(['pending', 'trading']) })
    .limit(1)
    .get();

  if (ongoing.data.length > 0) throw E.ONGOING_ORDER;

  await products.doc(productId).update({
    data: { status: 'deleted', updatedAt: new Date() }
  });

  return ok({ ok: true });
}

/**
 * 我的发布
 */
async function myList(event, openid) {
  const { status, cursor, pageSize = DEFAULT_PAGE_SIZE } = event;
  const size = Math.min(Number(pageSize) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const user = await requireUser(openid);

  const where = { sellerId: user._id };

  // 「我的发布」只列二手闲置。跑腿有独立的「我的跑腿」页（errandMyList），
  // 混在一起会让两边的状态文案（在售 / 待接单）打架。
  where.type = _.neq(TYPE_ERRAND);

  if (status) {
    where.status = status;
  } else {
    // 「全部」不包含已删除
    where.status = _.neq('deleted');
  }

  if (cursor) where.createdAt = _.lt(new Date(cursor));

  const res = await products
    .where(where)
    .orderBy('createdAt', 'desc')
    .limit(size + 1)
    .get();

  const hasMore = res.data.length > size;
  const rows = hasMore ? res.data.slice(0, size) : res.data;

  return ok({
    list: rows.map(pickListItem),
    hasMore,
    nextCursor: rows.length ? rows[rows.length - 1].createdAt : null
  });
}

/**
 * 收藏 / 取消收藏
 */
async function toggleFavorite(event, openid) {
  const { productId } = event;
  if (!productId) throw E.PARAM;

  const user = await requireUser(openid);

  const exist = await favorites
    .where({ userId: user._id, productId })
    .limit(1)
    .get();

  if (exist.data.length > 0) {
    // 取消收藏
    await favorites.doc(exist.data[0]._id).remove();
    // 收藏数 -1
    products
      .doc(productId)
      .update({ data: { favCount: _.inc(-1) } })
      .catch(e => console.error('[favCount-] failed:', e));

    return ok({ isFavorited: false });
  }

  // 收藏
  const productRes = await products.doc(productId).get().catch(() => null);
  const product = productRes && productRes.data;
  if (!product) throw E.NOT_FOUND;

  await favorites.add({
    data: {
      _openid: openid,
      userId: user._id,
      productId,
      productSnapshot: {
        title: product.title,
        price: product.price,
        cover: product.cover,
        status: product.status
      },
      createdAt: new Date()
    }
  });

  products
    .doc(productId)
    .update({ data: { favCount: _.inc(1) } })
    .catch(e => console.error('[favCount+] failed:', e));

  return ok({ isFavorited: true });
}

/**
 * 我的收藏
 */
async function myFavorites(event, openid) {
  const { cursor, pageSize = DEFAULT_PAGE_SIZE } = event;
  const size = Math.min(Number(pageSize) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const user = await requireUser(openid);

  const where = { userId: user._id };
  if (cursor) where.createdAt = _.lt(new Date(cursor));

  const res = await favorites
    .where(where)
    .orderBy('createdAt', 'desc')
    .limit(size + 1)
    .get();

  const hasMore = res.data.length > size;
  const rows = hasMore ? res.data.slice(0, size) : res.data;

  // 商品可能已下架或已售，用最新状态覆盖快照
  const ids = rows.map(r => r.productId);
  let productMap = {};

  if (ids.length > 0) {
    const pRes = await products.where({ _id: _.in(ids) }).get();
    pRes.data.forEach(p => { productMap[p._id] = p; });
  }

  // **已删除（或档案已不存在）的商品不再返回**——这种卡片点进去只会得到
  // 「商品不存在或已被删除」，而且收藏列表里没有任何入口能把它清掉，
  // 会永久占位（用户看到的就是「点进去说已删除」）。
  const list = [];
  for (const r of rows) {
    const p = productMap[r.productId];
    if (!p || p.status === 'deleted') {
      // 顺手清掉这条失效收藏（自愈）：它永远不会再出现在列表里，
      // 却会让「我的」页的收藏数一直虚高 →「显示 1 条，点进去空的」。
      // 数字口径已在 user/getProfile#countValidFavorites 对齐，这里负责把垃圾清掉。
      favorites
        .doc(r._id)
        .remove()
        .catch(e => console.warn('[myFavorites] 清理失效收藏失败:', r._id, e));
      continue;
    }
    list.push({ ...pickListItem(p), favoritedAt: r.createdAt });
  }

  return ok({
    list,
    hasMore,
    nextCursor: rows.length ? rows[rows.length - 1].createdAt : null
  });
}

/**
 * 举报
 */
async function report(event, openid) {
  const { targetType, targetId, reason, detail } = event;
  if (!targetType || !targetId || !reason) throw E.PARAM;

  const user = await requireUser(openid);

  await reports.add({
    data: {
      _openid: openid,
      userId: user._id,
      targetType,
      targetId,
      reason,
      detail: detail || '',
      status: 'pending',
      createdAt: new Date()
    }
  });

  return ok({ ok: true });
}

/* ---------- 校园跑腿 ----------
 * 状态机（errandStatus）：
 *   open ──接单──> taken ──发布者确认──> done
 *     ^              │
 *     └──接单人放弃──┘
 *   open/taken ──发布者取消──> canceled
 * 与 status 的对应：open=on_sale、taken=trading、done=done、canceled=off_shelf。
 * 这样列表查询（看 status）不用为跑腿单开一套。
 */

/** 取一条跑腿任务，并校验它确实是跑腿 */
async function getErrand(productId) {
  const res = await products.doc(productId).get().catch(() => null);
  const task = res && res.data;
  if (!task || task.status === 'deleted') throw E.NOT_FOUND;
  if (task.type !== TYPE_ERRAND) throw E.NOT_ERRAND;
  return task;
}

/**
 * 接单
 *
 * 并发要点：两个同学同时点「接单」时必须只有一个成功。
 * 如果先 get 再 update，两次请求都会读到 open、都会写成功，
 * 后写的把先写的顶掉（抢单超卖）。
 * 所以这里用「带条件的原子更新」——把 status/errandStatus 作为 where 条件，
 * 谁先把它们改掉谁赢，另一个人的 update 匹配 0 条，如实告诉他被抢了。
 */
async function errandAccept(event, openid) {
  const { productId } = event;
  if (!productId) throw E.PARAM;

  const user = await requireVerified(openid);
  const task = await getErrand(productId);

  if (task.sellerId === user._id) throw E.ERRAND_SELF;
  if (task.status !== 'on_sale' || task.errandStatus !== 'open') throw E.ERRAND_TAKEN;

  const now = new Date();
  const upd = await products
    .where({ _id: productId, status: 'on_sale', errandStatus: 'open' })
    .update({
      data: {
        status: 'trading',
        errandStatus: 'taken',
        runnerId: user._id,
        runnerName: user.nickName,
        runnerAvatar: user.avatarUrl,
        runnerOpenid: openid,
        takenAt: now,
        updatedAt: now
      }
    });

  if (!upd.stats || upd.stats.updated === 0) throw E.ERRAND_TAKEN;

  return ok({ status: 'trading', errandStatus: 'taken' });
}

/** 完成：由**发布者**确认（接单人不能自己说完成了就完成） */
async function errandFinish(event, openid) {
  const { productId } = event;
  if (!productId) throw E.PARAM;

  const user = await requireUser(openid);
  const task = await getErrand(productId);

  if (task.sellerId !== user._id) throw E.NO_PERM;
  if (task.errandStatus !== 'taken') throw E.ERRAND_STATE;

  const now = new Date();
  await products.doc(productId).update({
    data: {
      status: 'done',
      errandStatus: 'done',
      doneAt: now,
      updatedAt: now
    }
  });

  return ok({ status: 'done', errandStatus: 'done' });
}

/** 接单人放弃：任务回到「待接单」，别人可以再接 */
async function errandAbandon(event, openid) {
  const { productId } = event;
  if (!productId) throw E.PARAM;

  const user = await requireUser(openid);
  const task = await getErrand(productId);

  if (task.runnerId !== user._id) throw E.NO_PERM;
  if (task.errandStatus !== 'taken') throw E.ERRAND_STATE;

  const now = new Date();
  await products.doc(productId).update({
    data: {
      status: 'on_sale',
      errandStatus: 'open',
      runnerId: '',
      runnerName: '',
      runnerAvatar: '',
      runnerOpenid: '',
      takenAt: null,
      updatedAt: now
    }
  });

  return ok({ status: 'on_sale', errandStatus: 'open' });
}

/** 发布者取消任务 */
async function errandCancel(event, openid) {
  const { productId } = event;
  if (!productId) throw E.PARAM;

  const user = await requireUser(openid);
  const task = await getErrand(productId);

  if (task.sellerId !== user._id) throw E.NO_PERM;
  if (task.errandStatus === 'done') throw E.ERRAND_STATE;

  const now = new Date();
  await products.doc(productId).update({
    data: {
      // off_shelf 让任务从列表里消失，但详情页仍能打开（显示「已取消」），
      // 用 deleted 的话发布者自己也查不到历史了
      status: 'off_shelf',
      errandStatus: 'canceled',
      updatedAt: now
    }
  });

  return ok({ status: 'off_shelf', errandStatus: 'canceled' });
}

/**
 * 删除跑腿任务（软删除：status='deleted'，与商品的 remove 保持同一套语义）
 *
 * 只允许删除**已经结束**的任务（已取消 / 已完成）：
 *   - open 的任务列表里还有人能接，删了等于凭空拿走
 *   - taken 的任务有人正在跑，删掉会让对方的「我接的」凭空消失
 * 所以状态校验放在权限校验之后、更新之前。
 *
 * 不能复用商品的 remove：那个只查 orders 集合里有没有进行中的订单，
 * 而跑腿**根本不建订单**（任务本身就是订单），复用的结果是把
 * status='trading' 的进行中任务也一起放过去了。
 */
async function errandRemove(event, openid) {
  const { productId } = event;
  if (!productId) throw E.PARAM;

  const user = await requireUser(openid);
  const task = await getErrand(productId);

  if (task.sellerId !== user._id) throw E.NO_PERM;
  if (task.errandStatus !== 'canceled' && task.errandStatus !== 'done') throw E.ERRAND_STATE;

  await products.doc(productId).update({
    data: { status: 'deleted', updatedAt: new Date() }
  });

  return ok({ ok: true });
}

/**
 * 我的跑腿
 * role: publisher=我发布的 / runner=我接的
 *
 * 这里不做游标分页：跑腿任务量小（一个学校一天也就几十条），
 * 直接给最近 50 条更省事，也少一个分页 bug 的来源。
 */
async function errandMyList(event, openid) {
  const { role = 'publisher' } = event;

  const user = await requireUser(openid);

  const where = { type: TYPE_ERRAND };
  if (role === 'runner') {
    where.runnerId = user._id;
  } else {
    where.sellerId = user._id;
    where.status = _.neq('deleted');
  }

  const res = await products
    .where(where)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  return ok({ list: res.data.map(pickListItem), hasMore: false });
}

/* ---------- 入口 ---------- */

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  try {
    if (!OPENID) throw E.NOT_LOGIN;

    switch (event.action) {
      case 'publish': return await publish(event, OPENID);
      case 'list': return await list(event, OPENID);
      case 'detail': return await detail(event, OPENID);
      case 'offShelf': return await offShelf(event, OPENID);
      case 'remove': return await remove(event, OPENID);
      case 'myList': return await myList(event, OPENID);
      case 'toggleFavorite': return await toggleFavorite(event, OPENID);
      case 'myFavorites': return await myFavorites(event, OPENID);
      case 'report': return await report(event, OPENID);
      // 校园跑腿
      case 'errandAccept': return await errandAccept(event, OPENID);
      case 'errandFinish': return await errandFinish(event, OPENID);
      case 'errandAbandon': return await errandAbandon(event, OPENID);
      case 'errandCancel': return await errandCancel(event, OPENID);
      case 'errandRemove': return await errandRemove(event, OPENID);
      case 'errandMyList': return await errandMyList(event, OPENID);
      default: return fail(40004, '未知的操作');
    }
  } catch (e) {
    if (Array.isArray(e)) return fail(e[0], e[1]);
    if (isCollectionMissing(e)) {
      console.error('[product] 集合不存在，请先运行初始化:', event.action, e);
      return fail(50002, '数据库还没初始化，请到「我的」页面点击「初始化数据库」');
    }
    console.error('[product] error:', event.action, e);
    const detail = (e && (e.errMsg || e.message)) || '';
    return fail(50000, detail ? `服务异常：${detail}` : '服务异常，请稍后重试');
  }
};
