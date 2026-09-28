/**
 * 云函数 admin — 管理端
 *
 * actions:
 *   checkAdmin          检查当前用户是否管理员
 *   stats               概览数据（待审核数、待处理举报数等）
 *   listVerifyRequests  认证申请列表
 *   auditVerify         审核认证（通过/驳回）
 *   resetVerify         重置认证状态为未认证（用于让用户重新提交）
 *   listReports         举报列表
 *   handleReport        处理举报（下架商品/忽略）
 *   listProducts        商品管理列表
 *   blockProduct        强制下架违规商品
 *   banUser             封禁/解封用户
 *
 * 权限：所有 action 都先过 requireAdmin()
 * 管理员名单来源：数据库 config 集合、_id='admin' 的文档、字段 openids
 * （放数据库而不是写死在代码里，加管理员不用重新部署）
 * 该文档不存在时，第一个调用者自动自举为管理员（仅此一次）
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const users = db.collection('users');
const products = db.collection('products');
const orders = db.collection('orders');
const reports = db.collection('reports');
const favorites = db.collection('favorites');
const configColl = db.collection('config');

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
  NO_ADMIN: [40202, '需要管理员权限'],
  NOT_FOUND: [40401, '对象不存在'],
  SERVER: [50000, '服务异常，请稍后重试']
};

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;

/* ---------- 权限 ---------- */

/**
 * 管理员名单存在 config 集合，文档 _id = 'admin'
 * 结构：{ _id: 'admin', openids: ['oXXX', 'oYYY'] }
 *
 * 首次使用时数据库里没有这个文档 —— 此时允许第一个调用者「自举」成为管理员，
 * 但也仅此一次。这样用户不用手动建文档就能进后台。
 */
async function getAdminOpenids() {
  try {
    const res = await configColl.doc('admin').get();
    return (res.data && res.data.openids) || [];
  } catch (e) {
    return null; // 文档不存在
  }
}

async function requireAdmin(openid) {
  const openids = await getAdminOpenids();

  // 自举：config/admin 文档不存在时，第一个进来的用户成为管理员
  if (openids === null) {
    try {
      await configColl.add({
        data: {
          _id: 'admin',
          openids: [openid],
          createdAt: new Date(),
          bootstrapped: true
        }
      });
      console.log('[admin] bootstrap: first admin =', openid);
      return openid;
    } catch (e) {
      // 并发情况下别人先建了，重新读一次
      const retry = await getAdminOpenids();
      if (Array.isArray(retry) && retry.includes(openid)) return openid;

      // 写不进去基本只有一个原因：config 集合不存在。
      // 这时候报「需要管理员权限」会完全误导排查方向。
      const msg = String((e && (e.errMsg || e.message)) || '');
      console.error('[admin] bootstrap 失败:', msg);
      if (/collection|not exist|-502005|-501001/i.test(msg) || retry === null) {
        throw [50002, '数据库未初始化（缺少 config 集合），请先运行初始化'];
      }
      throw E.NO_ADMIN;
    }
  }

  if (!openids.includes(openid)) throw E.NO_ADMIN;
  return openid;
}

/* ---------- actions ---------- */

/** 检查是否管理员（客户端用它决定要不要显示后台入口） */
async function checkAdmin(event, openid) {
  const openids = await getAdminOpenids();

  if (openids === null) {
    // 还没人当过管理员。这里不能只是"乐观地"说 true ——
    // 必须确认真的能把自己写进去，否则用户会看到入口点进去却处处 40202。
    try {
      await configColl.add({
        data: {
          _id: 'admin',
          openids: [openid],
          createdAt: new Date(),
          bootstrapped: true
        }
      });
      console.log('[admin] bootstrap via checkAdmin:', openid);
      return ok({ isAdmin: true, isBootstrap: true });
    } catch (e) {
      // 并发：别人抢先建了，重新读一次
      const retry = await getAdminOpenids();
      if (Array.isArray(retry)) {
        return ok({ isAdmin: retry.includes(openid), isBootstrap: false });
      }
      // 写不进去（多半是 config 集合不存在），如实告知
      console.error('[admin] checkAdmin bootstrap 失败:', e && (e.errMsg || e.message));
      return ok({
        isAdmin: false,
        isBootstrap: false,
        error: 'config 集合不存在，请先运行数据库初始化'
      });
    }
  }

  return ok({
    isAdmin: openids.includes(openid),
    isBootstrap: false
  });
}

/** 概览统计 */
async function stats(event, openid) {
  await requireAdmin(openid);

  const [pendingVerify, pendingReports, onSaleProducts, totalUsers, totalOrders] =
    await Promise.all([
      users.where({ verifyStatus: 'pending' }).count(),
      reports.where({ status: 'pending' }).count(),
      products.where({ status: 'on_sale' }).count(),
      users.count(),
      orders.count()
    ]);

  return ok({
    pendingVerify: pendingVerify.total,
    pendingReports: pendingReports.total,
    onSaleProducts: onSaleProducts.total,
    totalUsers: totalUsers.total,
    totalOrders: totalOrders.total
  });
}

/** 认证申请列表 */
async function listVerifyRequests(event, openid) {
  await requireAdmin(openid);

  const { status = 'pending', cursor, pageSize = DEFAULT_PAGE_SIZE } = event;
  const size = Math.min(Number(pageSize) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const where = { verifyStatus: status };
  if (cursor) where.updatedAt = _.lt(new Date(cursor));

  const res = await users
    .where(where)
    .orderBy('updatedAt', 'desc')
    .limit(size)
    .get();

  const list = res.data.map(u => ({
    _id: u._id,
    nickName: u.nickName,
    avatarUrl: u.avatarUrl,
    realName: u.realName,
    studentNo: u.studentNo,
    schoolName: u.schoolName,
    verifyStatus: u.verifyStatus,
    updatedAt: u.updatedAt,
    createdAt: u.createdAt
  }));

  return ok({
    list,
    hasMore: res.data.length === size,
    nextCursor: res.data.length ? res.data[res.data.length - 1].updatedAt : null
  });
}

/** 审核认证 */
async function auditVerify(event, openid) {
  await requireAdmin(openid);

  const { targetUserId, pass, reason } = event;
  if (!targetUserId) throw E.PARAM;

  const target = await users.doc(targetUserId).get().catch(() => null);
  if (!target || !target.data) throw E.NOT_FOUND;

  await users.doc(targetUserId).update({
    data: {
      verifyStatus: pass ? 'passed' : 'rejected',
      verifyReason: pass ? '' : reason || '信息不完整，请重新提交',
      updatedAt: new Date()
    }
  });

  return ok({
    userId: targetUserId,
    verifyStatus: pass ? 'passed' : 'rejected'
  });
}

/**
 * 重置用户的认证状态为「未认证」，并清空学号姓名
 *
 * 用途：用户重复提交、学号填错需要重来时，管理员把记录清干净让他重新认证。
 * 注意：必须同时清空 studentNo，否则该学号仍被视为已占用，用户改不了。
 */
async function resetVerify(event, openid) {
  await requireAdmin(openid);

  const { targetUserId } = event;
  if (!targetUserId) throw E.PARAM;

  const target = await users.doc(targetUserId).get().catch(() => null);
  if (!target || !target.data) throw E.NOT_FOUND;

  await users.doc(targetUserId).update({
    data: {
      verifyStatus: 'none',
      verifyReason: '',
      studentNo: '',
      realName: '',
      updatedAt: new Date()
    }
  });

  return ok({ userId: targetUserId, verifyStatus: 'none' });
}

/** 举报列表 */
async function listReports(event, openid) {
  await requireAdmin(openid);

  const { status = 'pending', cursor, pageSize = DEFAULT_PAGE_SIZE } = event;
  const size = Math.min(Number(pageSize) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const where = {};
  if (status && status !== 'all') where.status = status;
  if (cursor) where.createdAt = _.lt(new Date(cursor));

  const res = await reports
    .where(where)
    .orderBy('createdAt', 'desc')
    .limit(size)
    .get();

  // 补充被举报对象的详情，方便管理员判断
  const productIds = res.data
    .filter(r => r.targetType === 'product')
    .map(r => r.targetId);

  let productMap = {};
  if (productIds.length > 0) {
    const pRes = await products
      .where({ _id: _.in([...new Set(productIds)]) })
      .get();
    pRes.data.forEach(p => {
      productMap[p._id] = {
        _id: p._id,
        title: p.title,
        cover: p.cover,
        price: p.price,
        status: p.status,
        sellerName: p.sellerName
      };
    });
  }

  const list = res.data.map(r => ({
    _id: r._id,
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    detail: r.detail,
    status: r.status,
    createdAt: r.createdAt,
    target: productMap[r.targetId] || null
  }));

  return ok({
    list,
    hasMore: res.data.length === size,
    nextCursor: res.data.length ? res.data[res.data.length - 1].createdAt : null
  });
}

/** 处理举报 */
async function handleReport(event, openid) {
  await requireAdmin(openid);

  // op 而不是 action：action 是 main 里的分发键
  const { reportId, op, note } = event;
  if (!reportId || !op) throw E.PARAM;
  if (!['block', 'ignore'].includes(op)) throw E.PARAM;

  const reportRes = await reports.doc(reportId).get().catch(() => null);
  const report = reportRes && reportRes.data;
  if (!report) throw E.NOT_FOUND;

  // 下架被举报的商品
  if (op === 'block' && report.targetType === 'product') {
    await products.doc(report.targetId).update({
      data: {
        status: 'blocked',
        updatedAt: new Date()
      }
    }).catch(e => console.error('[handleReport] block product failed:', e));
  }

  await reports.doc(reportId).update({
    data: {
      status: op === 'block' ? 'handled' : 'ignored',
      handleNote: note || '',
      handledAt: new Date()
    }
  });

  return ok({ ok: true });
}

/** 商品管理列表 */
async function listProducts(event, openid) {
  await requireAdmin(openid);

  const { status, keyword, cursor, pageSize = DEFAULT_PAGE_SIZE } = event;
  const size = Math.min(Number(pageSize) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const where = {};
  if (status && status !== 'all') where.status = status;
  if (keyword && String(keyword).trim()) {
    const safe = String(keyword).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    where.title = db.RegExp({ regexp: safe, options: 'i' });
  }
  if (cursor) where.createdAt = _.lt(new Date(cursor));

  const res = await products
    .where(where)
    .orderBy('createdAt', 'desc')
    .limit(size)
    .get();

  const list = res.data.map(p => ({
    _id: p._id,
    title: p.title,
    cover: p.cover,
    price: p.price,
    status: p.status,
    sellerId: p.sellerId,
    sellerName: p.sellerName,
    schoolId: p.schoolId,
    createdAt: p.createdAt
  }));

  return ok({
    list,
    hasMore: res.data.length === size,
    nextCursor: res.data.length ? res.data[res.data.length - 1].createdAt : null
  });
}

/** 强制下架 / 恢复商品 */
async function blockProduct(event, openid) {
  await requireAdmin(openid);

  const { productId, op } = event;
  if (!productId || !op) throw E.PARAM;
  if (!['block', 'restore'].includes(op)) throw E.PARAM;

  const target = await products.doc(productId).get().catch(() => null);
  if (!target || !target.data) throw E.NOT_FOUND;

  const status = op === 'block' ? 'blocked' : 'on_sale';

  await products.doc(productId).update({
    data: { status, updatedAt: new Date() }
  });

  return ok({ productId, status });
}

/** 封禁 / 解封用户 */
async function banUser(event, openid) {
  await requireAdmin(openid);

  const { targetUserId, op, reason } = event;
  if (!targetUserId || !op) throw E.PARAM;
  if (!['ban', 'unban'].includes(op)) throw E.PARAM;

  const target = await users.doc(targetUserId).get().catch(() => null);
  if (!target || !target.data) throw E.NOT_FOUND;

  const status = op === 'ban' ? 'banned' : 'active';

  await users.doc(targetUserId).update({
    data: {
      status,
      banReason: op === 'ban' ? reason || '违反平台规则' : '',
      updatedAt: new Date()
    }
  });

  // 封禁时把他所有在售商品一并下架
  if (op === 'ban') {
    products
      .where({ sellerId: targetUserId, status: 'on_sale' })
      .update({ data: { status: 'off_shelf', updatedAt: new Date() } })
      .catch(e => console.error('[banUser] off shelf failed:', e));
  }

  return ok({ userId: targetUserId, status });
}

/* ---------- 入口 ---------- */

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  try {
    if (!OPENID) throw E.NOT_LOGIN;

    switch (event.action) {
      case 'checkAdmin': return await checkAdmin(event, OPENID);
      case 'stats': return await stats(event, OPENID);
      case 'listVerifyRequests': return await listVerifyRequests(event, OPENID);
      case 'auditVerify': return await auditVerify(event, OPENID);
      case 'resetVerify': return await resetVerify(event, OPENID);
      case 'listReports': return await listReports(event, OPENID);
      case 'handleReport': return await handleReport(event, OPENID);
      case 'listProducts': return await listProducts(event, OPENID);
      case 'blockProduct': return await blockProduct(event, OPENID);
      case 'banUser': return await banUser(event, OPENID);
      default: return fail(40004, '未知的操作');
    }
  } catch (e) {
    if (Array.isArray(e)) return fail(e[0], e[1]);
    if (isCollectionMissing(e)) {
      console.error('[admin] 集合不存在，请先运行初始化:', event.action, e);
      return fail(50002, '数据库还没初始化，请到「我的」页面点击「初始化数据库」');
    }
    console.error('[admin] error:', event.action, e);
    const detail = (e && (e.errMsg || e.message)) || '';
    return fail(50000, detail ? `服务异常：${detail}` : '服务异常，请稍后重试');
  }
};
