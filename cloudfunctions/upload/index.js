/**
 * 云函数 upload — 上传模块
 * actions: getTempUrl / deleteFiles / imgSecCheck
 *
 * 图片上传本身走客户端直传（wx.cloud.uploadFile），不走这里：
 * 云函数上传需要 base64，体积膨胀 33% 且有 10MB 限制，得不偿失。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const users = db.collection('users');

/* ---------- 响应 ---------- */
const ok = data => ({ code: 0, msg: 'ok', data: data || null });
const fail = (code, msg) => ({ code, msg, data: null });

const E = {
  PARAM: [40001, '参数缺失'],
  NOT_LOGIN: [40101, '未登录'],
  NO_PERM: [40201, '无权操作'],
  SERVER: [50000, '服务异常，请稍后重试']
};

const MAX_FILES = 50;

// 单次内容安全检测的图片上限（同步接口，逐张都有耗时）
const MAX_CHECK = 9;

async function requireUser(openid) {
  const res = await users.where({ _openid: openid }).limit(1).get();
  const user = res.data[0];
  if (!user) throw E.NOT_LOGIN;
  return user;
}

/**
 * 批量换取临时访问链接
 * 注意：<image> 组件可以直接用 cloud:// 地址，通常不需要这个接口。
 * 需要下载文件或给 web 端用的时候才调。
 */
async function getTempUrl(event, openid) {
  const { fileIDs } = event;
  if (!Array.isArray(fileIDs) || fileIDs.length === 0) throw E.PARAM;
  if (fileIDs.length > MAX_FILES) throw E.PARAM;

  await requireUser(openid);

  const res = await cloud.getTempFileURL({ fileList: fileIDs.slice(0, MAX_FILES) });

  const urls = {};
  (res.fileList || []).forEach(f => {
    urls[f.fileID] = f.tempFileURL || '';
  });

  return ok({ urls });
}

/**
 * 删除文件
 * 权限校验：只能删自己上传的（云存储路径里含自己的 _id）
 */
async function deleteFiles(event, openid) {
  const { fileIDs } = event;
  if (!Array.isArray(fileIDs) || fileIDs.length === 0) throw E.PARAM;

  const user = await requireUser(openid);

  // 路径格式：products/{userId}/{timestamp}-{rand}.jpg
  // 只允许删除包含自己 userId 的文件
  const allowed = fileIDs.filter(id => {
    const parts = String(id).split('/');
    return parts.includes(user._id);
  });

  if (allowed.length === 0) throw E.NO_PERM;

  const res = await cloud.deleteFile({ fileList: allowed });

  return ok({
    deleted: (res.fileList || []).filter(f => f.status === 0).map(f => f.fileID),
    failed: (res.fileList || []).filter(f => f.status !== 0).map(f => f.fileID)
  });
}

/* ---------- 图片内容安全 ---------- */

const CONTENT_TYPES = [
  { exts: ['png'], type: 'image/png' },
  { exts: ['jpg', 'jpeg'], type: 'image/jpeg' },
  { exts: ['gif'], type: 'image/gif' },
  { exts: ['webp'], type: 'image/webp' },
  { exts: ['bmp'], type: 'image/bmp' }
];

/**
 * 从 fileID 推断 Content-Type
 * 原来写死了 image/png，jpg 图片会被当成 png 送检，容易被接口拒掉
 */
function guessContentType(fileID) {
  const name = String(fileID).split('?')[0].toLowerCase();
  const ext = name.split('.').pop();
  const hit = CONTENT_TYPES.find(c => c.exts.includes(ext));
  return hit ? hit.type : 'image/jpeg';
}

/**
 * 图片内容安全检测
 * 前端传 fileID，云函数下载后送检
 *
 * 两个关键取舍：
 * 1. 并行送检 —— 串行逐张累加耗时，9 张图很容易把云函数拖到超时。
 * 2. 异常降级放行（fail-open）—— 只有明确判定违规（errCode 87014）才拦。
 *    imgSecCheck 是同步接口，单图有 1MB / 750x1334 的尺寸上限，超限必然报错；
 *    若把「接口报错」也当作违规，用户会莫名其妙发不出商品。
 *    代价是这类图会漏过，所以发布页还有第二道人工审核（管理员可下架）。
 */
async function imgSecCheck(event, openid) {
  const { fileIDs } = event;
  if (!Array.isArray(fileIDs) || fileIDs.length === 0) throw E.PARAM;

  await requireUser(openid);

  const targets = fileIDs.slice(0, MAX_CHECK);
  const results = {};

  await Promise.all(
    targets.map(async fileID => {
      try {
        const download = await cloud.downloadFile({ fileID });
        await cloud.openapi.security.imgSecCheck({
          media: {
            contentType: guessContentType(fileID),
            value: download.fileContent
          }
        });
        results[fileID] = 'pass';
      } catch (e) {
        // errCode 87014 = 图片含违规内容，这是唯一需要拦截的情况
        if (e.errCode === 87014) {
          results[fileID] = 'risky';
        } else {
          console.error('[imgSecCheck] 接口异常，降级放行:', fileID, e.errCode || e.message);
          results[fileID] = 'pass';
        }
      }
    })
  );

  const risky = targets.filter(id => results[id] === 'risky');

  return ok({
    pass: risky.length === 0,
    risky,
    checked: targets.length,
    total: fileIDs.length,
    results
  });
}

/* ---------- 入口 ---------- */

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  try {
    if (!OPENID) throw E.NOT_LOGIN;

    switch (event.action) {
      case 'getTempUrl': return await getTempUrl(event, OPENID);
      case 'deleteFiles': return await deleteFiles(event, OPENID);
      case 'imgSecCheck': return await imgSecCheck(event, OPENID);
      default: return fail(40004, '未知的操作');
    }
  } catch (e) {
    if (Array.isArray(e)) return fail(e[0], e[1]);
    console.error('[upload] error:', event.action, e);
    return fail(50000, '服务异常，请稍后重试');
  }
};
