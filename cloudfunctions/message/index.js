/**
 * 云函数 message — 消息模块
 * actions: send / listMessages / listConversations / getConversationId
 *
 * 聊天实时性由客户端 db.watch() 提供，这里只负责发送和查询
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

const messages = db.collection('messages');
const users = db.collection('users');
const products = db.collection('products');

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
  TOO_LONG: [40003, '消息内容过长'],
  NOT_LOGIN: [40101, '未登录'],
  BANNED: [40102, '账号已被封禁'],
  SELF_MSG: [40308, '不能给自己发消息'],
  PEER_NOT_FOUND: [40401, '对方账号不存在'],
  RISKY: [40501, '消息包含违规内容'],
  SERVER: [50000, '服务异常，请稍后重试']
};

const MAX_CONTENT_LEN = 500;

/* ---------- 工具 ---------- */

async function requireUser(openid) {
  const res = await users.where({ _openid: openid }).limit(1).get();
  const user = res.data[0];
  if (!user) throw E.NOT_LOGIN;
  if (user.status === 'banned') throw E.BANNED;
  return user;
}

/**
 * 会话 ID：两个 openid 排序后拼接 + 商品 ID
 * 排序是关键 —— 否则 A→B 和 B→A 会得到两个不同 ID
 */
function makeConversationId(openidA, openidB, productId) {
  const pair = [openidA, openidB].sort().join('_');
  return productId ? `${pair}_${productId}` : pair;
}

/** 文本内容安全检测，异常降级放行 */
async function msgSecCheck(content, openid) {
  if (!content) return 'pass';
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: content.slice(0, 2500),
      version: 2,
      scene: 2,
      openid
    });
    const suggest = res && res.result && res.result.suggest;
    return suggest === 'risky' ? 'risky' : 'pass';
  } catch (e) {
    console.error('[msgSecCheck] failed:', e.errCode || e.message);
    return 'pass';
  }
}

/* ---------- actions ---------- */

/**
 * 计算会话 ID（从商品详情首次联系卖家时调用）
 */
async function getConversationId(event, openid) {
  const { toId, productId } = event;
  if (!toId) throw E.PARAM;

  const peerRes = await users.doc(toId).get().catch(() => null);
  const peer = peerRes && peerRes.data;
  if (!peer) throw E.PEER_NOT_FOUND;

  if (peer._openid === openid) throw E.SELF_MSG;

  return ok({
    conversationId: makeConversationId(openid, peer._openid, productId),
    peerOpenid: peer._openid
  });
}

/**
 * 发送消息
 */
async function send(event, openid) {
  const { toId, productId, content } = event;

  if (!toId || !content) throw E.PARAM;
  if (String(content).length > MAX_CONTENT_LEN) throw E.TOO_LONG;

  const user = await requireUser(openid);

  const peerRes = await users.doc(toId).get().catch(() => null);
  const peer = peerRes && peerRes.data;
  if (!peer) throw E.PEER_NOT_FOUND;
  if (peer._openid === openid) throw E.SELF_MSG;

  // 内容安全
  const auditResult = await msgSecCheck(String(content), openid);
  if (auditResult === 'risky') throw E.RISKY;

  const now = new Date();
  const conversationId = makeConversationId(openid, peer._openid, productId);

  const doc = {
    _openid: openid,
    conversationId,
    fromOpenid: openid,
    fromId: user._id,
    toOpenid: peer._openid,
    toId: peer._id,
    productId: productId || '',
    content: String(content).slice(0, MAX_CONTENT_LEN),
    type: 'text',
    read: false,
    auditResult,
    createdAt: now
  };

  const res = await messages.add({ data: doc });

  return ok({
    messageId: res._id,
    conversationId,
    createdAt: now
  });
}

/**
 * 聊天记录（倒序查，前端反转显示）
 */
async function listMessages(event, openid) {
  const { conversationId, cursor, pageSize = 30 } = event;
  if (!conversationId) throw E.PARAM;

  await requireUser(openid);

  const size = Math.min(Number(pageSize) || 30, 50);

  const where = { conversationId };
  if (cursor) where.createdAt = _.lt(new Date(cursor));

  const res = await messages
    .where(where)
    .orderBy('createdAt', 'desc')
    .limit(size)
    .get();

  // 把对方发给我的未读消息标记为已读
  messages
    .where({ conversationId, toOpenid: openid, read: false })
    .update({ data: { read: true } })
    .catch(e => console.error('[markRead] failed:', e));

  return ok({
    // 返回时反转成时间正序，前端不用再处理
    list: res.data.reverse(),
    hasMore: res.data.length === size
  });
}

/**
 * 会话列表（聚合）
 */
async function listConversations(event, openid) {
  await requireUser(openid);

  // 聚合：按 conversationId 分组，取每个会话最后一条 + 未读数
  const res = await messages
    .aggregate()
    .match({
      $or: [{ fromOpenid: openid }, { toOpenid: openid }]
    })
    .sort({ createdAt: -1 })
    .group({
      _id: '$conversationId',
      lastMessage: $.first({
        content: '$content',
        createdAt: '$createdAt',
        fromOpenid: '$fromOpenid',
        toOpenid: '$toOpenid'
      }),
      // 未读：发给我的且未读
      unreadCount: $.sum(
        $.cond({
          if: $.and([
            $.eq(['$toOpenid', openid]),
            $.eq(['$read', false])
          ]),
          then: 1,
          else: 0
        })
      ),
      productId: $.first('$productId')
    })
    .sort({ 'lastMessage.createdAt': -1 })
    .limit(50)
    .end();

  const groups = res.list || [];
  if (groups.length === 0) return ok({ list: [] });

  // 收集需要查询的 ID
  const peerOpenids = groups.map(g =>
    g.lastMessage.fromOpenid === openid ? g.lastMessage.toOpenid : g.lastMessage.fromOpenid
  );
  const productIds = groups.map(g => g.productId).filter(Boolean);

  const [uRes, pRes] = await Promise.all([
    users.where({ _openid: _.in([...new Set(peerOpenids)]) }).get(),
    productIds.length > 0
      ? products.where({ _id: _.in([...new Set(productIds)]) }).get()
      : Promise.resolve({ data: [] })
  ]);

  const userMap = {};
  uRes.data.forEach(u => {
    userMap[u._openid] = { _id: u._id, nickName: u.nickName, avatarUrl: u.avatarUrl };
  });

  const productMap = {};
  pRes.data.forEach(p => {
    productMap[p._id] = { _id: p._id, title: p.title, cover: p.cover };
  });

  const list = groups.map(g => {
    const peerOpenid =
      g.lastMessage.fromOpenid === openid ? g.lastMessage.toOpenid : g.lastMessage.fromOpenid;

    return {
      conversationId: g._id,
      peer: userMap[peerOpenid] || { _id: '', nickName: '同学', avatarUrl: '' },
      product: productMap[g.productId] || { _id: g.productId || '', title: '', cover: '' },
      lastMessage: {
        content: g.lastMessage.content,
        createdAt: g.lastMessage.createdAt,
        fromMe: g.lastMessage.fromOpenid === openid
      },
      unreadCount: g.unreadCount || 0
    };
  });

  return ok({ list });
}

/* ---------- 入口 ---------- */

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  try {
    if (!OPENID) throw E.NOT_LOGIN;

    switch (event.action) {
      case 'send': return await send(event, OPENID);
      case 'listMessages': return await listMessages(event, OPENID);
      case 'listConversations': return await listConversations(event, OPENID);
      case 'getConversationId': return await getConversationId(event, OPENID);
      default: return fail(40004, '未知的操作');
    }
  } catch (e) {
    if (Array.isArray(e)) return fail(e[0], e[1]);
    if (isCollectionMissing(e)) {
      console.error('[message] 集合不存在，请先运行初始化:', event.action, e);
      return fail(50002, '数据库还没初始化，请到「我的」页面点击「初始化数据库」');
    }
    console.error('[message] error:', event.action, e);
    const detail = (e && (e.errMsg || e.message)) || '';
    return fail(50000, detail ? `服务异常：${detail}` : '服务异常，请稍后重试');
  }
};
