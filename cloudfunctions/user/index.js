/**
 * 云函数 user — 用户模块
 * actions: login / submitVerify / getProfile / auditVerify
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const users = db.collection('users');
const products = db.collection('products');
const favorites = db.collection('favorites');

/* ---------- 统一响应 ---------- */
const ok = data => ({ code: 0, msg: 'ok', data: data || null });
const fail = (code, msg) => ({ code, msg, data: null });

/* ---------- 错误码 ---------- */
const E = {
  PARAM: [40001, '参数缺失'],
  FORMAT: [40002, '参数格式错误'],
  NOT_LOGIN: [40101, '未登录'],
  BANNED: [40102, '账号已被封禁'],
  NOT_VERIFIED: [40103, '请先完成校园认证'],
  NO_PERM: [40201, '无权操作'],
  DUP_STUDENT_NO: [40305, '该学号已被其他账号认证'],
  NOT_FOUND: [40401, '用户不存在'],
  SERVER: [50000, '服务异常，请稍后重试']
};

/* ---------- 工具 ---------- */

/** 取用户，不存在返回 null */
async function getUserByOpenid(openid) {
  const res = await users.where({ _openid: openid }).limit(1).get();
  return res.data[0] || null;
}

/**
 * 判断错误是否为「集合不存在」
 * 未跑初始化时最容易撞到，要给用户明确指引而不是笼统的「服务异常」
 */
function isCollectionMissing(e) {
  const msg = String((e && (e.errMsg || e.message)) || '');
  return (
    e && e.errCode === -502005 ||
    msg.includes('collection not exists') ||
    msg.includes('collection does not exist') ||
    msg.includes('DATABASE_COLLECTION_NOT_EXIST')
  );
}

/** 取用户，不存在则抛 40401 */
async function requireUser(openid) {
  const user = await getUserByOpenid(openid);
  if (!user) throw E.NOT_FOUND;
  if (user.status === 'banned') throw E.BANNED;
  return user;
}

/* ---------- actions ---------- */

/**
 * 登录 / 注册
 * openid 从 getWXContext 取，绝不信任客户端传值
 */
async function login(event, openid) {
  const { nickName, avatarUrl, schoolId, schoolName } = event;

  const exist = await getUserByOpenid(openid);
  const now = new Date();

  if (exist) {
    // 更新昵称头像（用户可能改了微信资料）
    const patch = { updatedAt: now };
    if (nickName) patch.nickName = nickName;
    if (avatarUrl) patch.avatarUrl = avatarUrl;

    // 学校名以 config.js 为准（单校部署，客户端每次登录都会带上）。
    // 这里必须「不一致就更新」，不能只在为空时补写 ——
    // 否则改了 config.school 之后，老用户记录里还是旧校名，
    // 会出现「小程序显示新校名、用户资料却是旧校名」的不一致。
    if (schoolId && schoolId !== exist.schoolId) patch.schoolId = schoolId;
    if (schoolName && schoolName !== exist.schoolName) patch.schoolName = schoolName;

    if (Object.keys(patch).length > 1) {
      await users.doc(exist._id).update({ data: patch });
    }

    return ok({
      isNewUser: false,
      ...exist,
      ...patch
    });
  }

  // 新用户
  const doc = {
    _openid: openid,
    nickName: nickName || '微信用户',
    avatarUrl: avatarUrl || '',
    studentNo: '',
    realName: '',
    schoolId: schoolId || '',
    schoolName: schoolName || '',
    verifyStatus: 'none',
    verifyReason: '',
    creditScore: 100,
    status: 'active',
    createdAt: now,
    updatedAt: now
  };

  const res = await users.add({ data: doc });

  return ok({
    isNewUser: true,
    _id: res._id,
    ...doc
  });
}

/**
 * 提交校园认证
 */
async function submitVerify(event, openid) {
  const { realName, studentNo, schoolId, schoolName } = event;

  if (!realName || !studentNo) throw E.PARAM;

  if (!/^[0-9A-Za-z]{6,20}$/.test(String(studentNo))) throw E.FORMAT;

  const user = await requireUser(openid);

  if (user.verifyStatus === 'passed') {
    return fail(40306, '你已完成认证');
  }

  // 学号查重：一个学号只能绑定一个账号
  const dup = await users
    .where({
      studentNo: String(studentNo),
      _openid: _.neq(openid),
      verifyStatus: _.in(['pending', 'passed'])
    })
    .limit(1)
    .get();

  if (dup.data.length > 0) throw E.DUP_STUDENT_NO;

  await users.doc(user._id).update({
    data: {
      realName,
      studentNo: String(studentNo),
      schoolId: schoolId || user.schoolId,
      schoolName: schoolName || user.schoolName,
      verifyStatus: 'pending',
      verifyReason: '',
      updatedAt: new Date()
    }
  });

  return ok({ verifyStatus: 'pending' });
}

/**
 * 获取个人资料 + 统计
 */
/**
 * 统计「有效收藏」数：只算那些商品还在（未被删除）的收藏。
 *
 * ⚠️ 为什么不能直接 `favorites.where({userId}).count()`：
 * 「我的收藏」列表（product/myFavorites）会**过滤掉商品已删除 / 档案已不存在的收藏**，
 * 而直接数记录条数会把这些也算进去 → 用户看到「收藏 1」，点进去却是空的。
 * 两处口径必须一致（真实缺陷，2026-09-18）。
 *
 * `_.in` 的数组上限是 100（云函数端），所以分批查。
 */
async function countValidFavorites(userId) {
  const PAGE = 100;
  let valid = 0;
  let skip = 0;

  for (;;) {
    const res = await favorites
      .where({ userId })
      .field({ productId: true })
      .skip(skip)
      .limit(PAGE)
      .get();

    const rows = res.data || [];
    if (!rows.length) break;

    const ids = rows.map(r => r.productId).filter(Boolean);
    if (ids.length) {
      const alive = await products
        .where({ _id: _.in(ids), status: _.neq('deleted') })
        .count();
      valid += alive.total;
    }

    if (rows.length < PAGE) break;
    skip += PAGE;
  }

  return valid;
}

async function getProfile(event, openid) {
  const user = await requireUser(openid);

  const [onSaleRes, soldRes, favCount] = await Promise.all([
    products.where({ sellerId: user._id, status: 'on_sale' }).count(),
    products.where({ sellerId: user._id, status: 'sold' }).count(),
    countValidFavorites(user._id)
  ]);

  return ok({
    userInfo: {
      _id: user._id,
      _openid: user._openid,
      nickName: user.nickName,
      avatarUrl: user.avatarUrl,
      studentNo: user.studentNo,
      realName: user.realName,
      schoolId: user.schoolId,
      schoolName: user.schoolName,
      verifyStatus: user.verifyStatus,
      verifyReason: user.verifyReason,
      creditScore: user.creditScore
    },
    stats: {
      onSale: onSaleRes.total,
      sold: soldRes.total,
      favCount
    }
  });
}

/**
 * 看别人的主页（点头像进来）
 *
 * 只返回「别人本来就看得见」的公开信息：昵称、头像、认证状态、信用分、在售商品。
 * 学号、真实姓名这类认证资料是**不返回**的 —— 点头像就能看到别人学号是隐私事故。
 * 查不到真实姓名，也就没法用「学号 + 姓名」去反查身份的用途。
 */
async function getPublicProfile(event, openid) {
  const { userId } = event;
  if (!userId) throw E.PARAM;

  const me = await getUserByOpenid(openid); // 允许游客（退出登录后仍可看）

  const res = await users.doc(userId).get().catch(() => null);
  const target = res && res.data;
  if (!target) throw E.NOT_FOUND;

  const pRes = await products
    .where({
      sellerId: target._id,
      status: 'on_sale',
      // 跑腿任务不算「闲置」，这里只列正在卖的二手
      type: _.neq('errand')
    })
    .orderBy('createdAt', 'desc')
    .limit(12)
    .get();

  const list = pRes.data.map(p => ({
    _id: p._id,
    title: p.title,
    price: p.price,
    oriPrice: p.oriPrice || 0,
    cover: p.cover,
    tradePlace: p.tradePlace,
    categoryName: p.categoryName,
    status: p.status,
    viewCount: p.viewCount || 0,
    sellerId: p.sellerId,
    sellerName: p.sellerName,
    sellerAvatar: p.sellerAvatar,
    createdAt: p.createdAt
  }));

  return ok({
    userInfo: {
      _id: target._id,
      nickName: target.nickName,
      avatarUrl: target.avatarUrl,
      verifyStatus: target.verifyStatus,
      creditScore: target.creditScore,
      schoolName: target.schoolName,
      createdAt: target.createdAt
    },
    isSelf: !!me && me._id === target._id,
    banned: target.status === 'banned',
    products: list
  });
}

/**
 * 审核认证（管理端）
 * 简化方案：用一个固定的管理员 openid 列表做校验
 * 更正规的做法是加一张 admins 表
 */
const ADMIN_OPENIDS = [
  // TODO: 把你的 openid 填进来（登录后在云开发控制台 users 表里可以看到）
  // 'oXXXXXXXXXXXXXXXXXXX'
];

async function auditVerify(event, openid) {
  const { targetUserId, pass, reason } = event;

  if (!targetUserId) throw E.PARAM;

  if (ADMIN_OPENIDS.length > 0 && !ADMIN_OPENIDS.includes(openid)) {
    throw E.NO_PERM;
  }

  await users.doc(targetUserId).update({
    data: {
      verifyStatus: pass ? 'passed' : 'rejected',
      verifyReason: pass ? '' : reason || '信息不完整，请重新提交',
      updatedAt: new Date()
    }
  });

  return ok({ ok: true });
}

/* ---------- 入口 ---------- */

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  try {
    if (!OPENID) throw E.NOT_LOGIN;

    switch (event.action) {
      case 'login':
        return await login(event, OPENID);
      case 'submitVerify':
        return await submitVerify(event, OPENID);
      case 'getProfile':
        return await getProfile(event, OPENID);
      case 'getPublicProfile':
        return await getPublicProfile(event, OPENID);
      case 'auditVerify':
        return await auditVerify(event, OPENID);
      default:
        return fail(40004, '未知的操作');
    }
  } catch (e) {
    // 业务异常用数组形式抛出，好识别
    if (Array.isArray(e)) {
      return fail(e[0], e[1]);
    }

    // 集合没建：这是首次部署最容易踩的坑，必须给出可操作指引
    if (isCollectionMissing(e)) {
      console.error('[user] 集合不存在，请先运行初始化:', event.action, e);
      return fail(
        50002,
        '数据库还没初始化，请到「我的」页面点击「初始化数据库」'
      );
    }

    console.error('[user] error:', event.action, e);
    // 把真实错误消息带出来，方便定位（开发期）
    const detail = (e && (e.errMsg || e.message)) || '';
    return fail(50000, detail ? `服务异常：${detail}` : '服务异常，请稍后重试');
  }
};
