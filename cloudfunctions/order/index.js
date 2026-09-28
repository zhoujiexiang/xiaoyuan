/**
 * 云函数 order — 订单模块
 * actions: create / updateStatus / list / detail
 *
 * 状态机（服务端强校验，前端说了不算）：
 *   pending  --卖家 accept-->  trading  --双方 complete-->  done
 *   pending/trading  --双方 cancel-->  canceled
 *   pending  --卖家 reject-->  canceled
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const orders = db.collection('orders');
const products = db.collection('products');
const users = db.collection('users');

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
  NOT_LOGIN: [40101, '未登录'],
  BANNED: [40102, '账号已被封禁'],
  NO_PERM: [40201, '无权操作'],
  SOLD: [40301, '商品已售出或已下架'],
  DUP_ORDER: [40302, '该商品已有进行中的订单'],
  BAD_STATUS: [40303, '当前订单状态不支持此操作'],
  SELF_BUY: [40304, '不能购买自己的商品'],
  NOT_FOUND: [40401, '商品不存在或已被删除'],
  ORDER_NOT_FOUND: [40402, '订单不存在'],
  SERVER: [50000, '服务异常，请稍后重试']
};

const MAX_PAGE_SIZE = 20;
const DEFAULT_PAGE_SIZE = 10;

/* ---------- 工具 ---------- */

async function requireUser(openid) {
  const res = await users.where({ _openid: openid }).limit(1).get();
  const user = res.data[0];
  if (!user) throw E.NOT_LOGIN;
  if (user.status === 'banned') throw E.BANNED;
  return user;
}

/** 生成订单号：YYYYMMDD + 6 位随机 */
function genOrderNo() {
  const d = new Date();
  const ymd =
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  const rand = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  return ymd + rand;
}

/**
 * 状态流转规则表
 * key = action，value = { from: 允许的前置状态, to: 目标状态, role: 谁能操作 }
 */
const TRANSITIONS = {
  accept: { from: ['pending'], to: 'trading', role: 'seller' },
  reject: { from: ['pending'], to: 'canceled', role: 'seller' },
  cancel: { from: ['pending', 'trading'], to: 'canceled', role: 'both' },
  complete: { from: ['trading'], to: 'done', role: 'both' }
};

/* ---------- actions ---------- */

/**
 * 下单
 */
async function create(event, openid) {
  const { productId, remark } = event;
  if (!productId) throw E.PARAM;

  const user = await requireUser(openid);

  // 1. 查商品
  const pRes = await products.doc(productId).get().catch(() => null);
  const product = pRes && pRes.data;
  if (!product || product.status === 'deleted') throw E.NOT_FOUND;

  // 2. 不能买自己的
  if (product.sellerId === user._id) throw E.SELF_BUY;

  // 3. 必须在售
  if (product.status !== 'on_sale') throw E.SOLD;

  // 4. 该商品不能已有进行中的订单
  const exist = await orders
    .where({ productId, status: _.in(['pending', 'trading']) })
    .limit(1)
    .get();

  if (exist.data.length > 0) throw E.DUP_ORDER;

  // 5. 写订单（存商品快照，订单必须自包含）
  const now = new Date();
  const doc = {
    _openid: openid,
    orderNo: genOrderNo(),
    productId,
    productSnapshot: {
      title: product.title,
      price: product.price,
      cover: product.cover
    },
    buyerId: user._id,
    buyerOpenid: openid,
    sellerId: product.sellerId,
    sellerOpenid: product._openid,
    price: product.price,
    status: 'pending',
    cancelReason: '',
    buyerRemark: remark || '',
    schoolId: product.schoolId || user.schoolId || '',
    doneAt: null,
    createdAt: now,
    updatedAt: now
  };

  const res = await orders.add({ data: doc });

  return ok({ orderId: res._id, orderNo: doc.orderNo });
}

/**
 * 变更订单状态
 */
async function updateStatus(event, openid) {
  // 业务动作字段名必须是 op，不能用 action —— action 是 main 里的分发键
  const { orderId, op, reason } = event;
  if (!orderId || !op) throw E.PARAM;

  const rule = TRANSITIONS[op];
  if (!rule) throw E.BAD_STATUS;

  const user = await requireUser(openid);

  const oRes = await orders.doc(orderId).get().catch(() => null);
  const order = oRes && oRes.data;
  if (!order) throw E.ORDER_NOT_FOUND;

  // 权限校验
  const isBuyer = order.buyerOpenid === openid;
  const isSeller = order.sellerOpenid === openid;

  if (!isBuyer && !isSeller) throw E.NO_PERM;

  if (rule.role === 'seller' && !isSeller) throw E.NO_PERM;
  if (rule.role === 'both' && !isBuyer && !isSeller) throw E.NO_PERM;

  // 状态校验
  if (!rule.from.includes(order.status)) throw E.BAD_STATUS;

  const now = new Date();
  const patch = { status: rule.to, updatedAt: now };

  if (op === 'cancel') patch.cancelReason = reason || '用户主动取消';
  if (rule.to === 'done') patch.doneAt = now;

  await orders.doc(orderId).update({ data: patch });

  // 联动商品状态
  const productPatch = {};
  if (op === 'accept') {
    // 卖家同意 → 商品锁定为已售
    productPatch.status = 'sold';
  } else if (op === 'cancel') {
    // 取消 → 商品回到在售（除非已删除或违规下架）
    const pRes = await products.doc(order.productId).get().catch(() => null);
    const p = pRes && pRes.data;
    if (p && (p.status === 'sold' || p.status === 'off_shelf')) {
      productPatch.status = 'on_sale';
    }
  } else if (op === 'reject') {
    // 拒绝 → 商品保持在售
    productPatch.status = 'on_sale';
  }
  // complete 时商品保持 sold，不需要改

  if (Object.keys(productPatch).length > 0) {
    productPatch.updatedAt = now;
    products
      .doc(order.productId)
      .update({ data: productPatch })
      .catch(e => console.error('[order] product sync failed:', e));
  }

  return ok({ status: rule.to });
}

/**
 * 我的订单列表
 */
async function list(event, openid) {
  const { role = 'buyer', status, cursor, pageSize = DEFAULT_PAGE_SIZE } = event;
  const size = Math.min(Number(pageSize) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const user = await requireUser(openid);

  const where = role === 'seller'
    ? { sellerOpenid: openid }
    : { buyerOpenid: openid };

  if (status) where.status = status;
  if (cursor) where.createdAt = _.lt(new Date(cursor));

  const res = await orders
    .where(where)
    .orderBy('createdAt', 'desc')
    .limit(size + 1)
    .get();

  const hasMore = res.data.length > size;
  const rows = hasMore ? res.data.slice(0, size) : res.data;

  // 批量取对方信息，避免 N+1 查询
  const peerIds = rows.map(o => (role === 'seller' ? o.buyerId : o.sellerId));
  const uniqIds = [...new Set(peerIds)].filter(Boolean);

  let userMap = {};
  if (uniqIds.length > 0) {
    const uRes = await users.where({ _id: _.in(uniqIds) }).get();
    uRes.data.forEach(u => {
      userMap[u._id] = { nickName: u.nickName, avatarUrl: u.avatarUrl };
    });
  }

  const list = rows.map(o => {
    const peerId = role === 'seller' ? o.buyerId : o.sellerId;
    return {
      _id: o._id,
      orderNo: o.orderNo,
      productId: o.productId,
      productSnapshot: o.productSnapshot,
      price: o.price,
      status: o.status,
      buyerRemark: o.buyerRemark,
      createdAt: o.createdAt,
      doneAt: o.doneAt,
      peer: userMap[peerId] || { nickName: '同学', avatarUrl: '' }
    };
  });

  return ok({
    list,
    hasMore,
    nextCursor: rows.length ? rows[rows.length - 1].createdAt : null
  });
}

/**
 * 订单详情
 */
async function detail(event, openid) {
  const { orderId } = event;
  if (!orderId) throw E.PARAM;

  const user = await requireUser(openid);

  const oRes = await orders.doc(orderId).get().catch(() => null);
  const order = oRes && oRes.data;
  if (!order) throw E.ORDER_NOT_FOUND;

  if (order.buyerOpenid !== openid && order.sellerOpenid !== openid) {
    throw E.NO_PERM;
  }

  const [pRes, bRes, sRes] = await Promise.all([
    products.doc(order.productId).get().catch(() => null),
    users.doc(order.buyerId).get().catch(() => null),
    users.doc(order.sellerId).get().catch(() => null)
  ]);

  return ok({
    order,
    product: pRes ? pRes.data : order.productSnapshot,
    buyer: bRes ? { _id: bRes.data._id, nickName: bRes.data.nickName, avatarUrl: bRes.data.avatarUrl } : null,
    seller: sRes ? { _id: sRes.data._id, nickName: sRes.data.nickName, avatarUrl: sRes.data.avatarUrl } : null
  });
}

/* ---------- 入口 ---------- */

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  try {
    if (!OPENID) throw E.NOT_LOGIN;

    switch (event.action) {
      case 'create': return await create(event, OPENID);
      case 'updateStatus': return await updateStatus(event, OPENID);
      case 'list': return await list(event, OPENID);
      case 'detail': return await detail(event, OPENID);
      default: return fail(40004, '未知的操作');
    }
  } catch (e) {
    if (Array.isArray(e)) return fail(e[0], e[1]);
    if (isCollectionMissing(e)) {
      console.error('[order] 集合不存在，请先运行初始化:', event.action, e);
      return fail(50002, '数据库还没初始化，请到「我的」页面点击「初始化数据库」');
    }
    console.error('[order] error:', event.action, e);
    const detail = (e && (e.errMsg || e.message)) || '';
    return fail(50000, detail ? `服务异常：${detail}` : '服务异常，请稍后重试');
  }
};
