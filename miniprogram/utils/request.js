/**
 * utils/request.js — 云函数调用统一封装
 * 所有页面调接口都用这个，不要在页面里直接 wx.cloud.callFunction
 */

const ERROR_NEED_LOGIN_MIN = 40100;
const ERROR_NEED_LOGIN_MAX = 40200;

/**
 * 调用云函数
 * @param {string} name    云函数名，如 'product'
 * @param {string} action  具体动作，如 'list'
 * @param {object} payload 业务参数
 * @param {object} options { loading: boolean|string, silent: boolean }
 * @returns {Promise<any>} 成功时 resolve 业务 data，失败时 reject Error
 */
async function call(name, action, payload = {}, options = {}) {
  const { loading = false, silent = false } = options;

  // action 是云函数的分发键，业务动作必须用别的字段名（约定为 op）。
  // 这里提前告警，避免又写出「payload 里的 action 把分发键顶掉」的 bug。
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'action')) {
    console.warn('[request] payload 里的 action 会被忽略（它是分发键），业务参数请改用 op:', name, action);
  }

  if (loading) {
    wx.showLoading({ title: typeof loading === 'string' ? loading : '加载中', mask: true });
  }

  try {
    const res = await wx.cloud.callFunction({
      name,
      // 顺序很重要：action 必须最后合并，否则 payload 里的同名字段会覆盖分发键，
      // 导致请求落到「未知的操作」分支（曾导致下架、取消订单等操作全部失效）
      data: { ...payload, action }
    });

    const result = res && res.result;

    // 云函数没按约定返回，当作服务端异常
    if (!result || typeof result.code === 'undefined') {
      throw makeError(50000, '服务异常，请稍后重试');
    }

    if (result.code !== 0) {
      const err = makeError(result.code, result.msg || '操作失败');
      handleErrorCode(err, silent);
      throw err;
    }

    return result.data;
  } catch (e) {
    // 已经是业务错误（带 code），直接抛
    if (e && e.code) throw e;

    // wx.cloud.callFunction 自身的失败（云函数不存在、环境未初始化等）
    // 不要把真实原因吞掉，否则排查时只能看到「网络异常」
    const raw = (e && (e.errMsg || e.message)) || '';
    let hint = '网络异常，请检查网络后重试';

    if (/cloud function .* not found|FUNCTION_NOT_FOUND/i.test(raw)) {
      hint = '云函数未部署，请先部署云函数';
    } else if (/env.*not.*(found|exist)|INVALID_ENV/i.test(raw)) {
      hint = '云环境配置有误，请检查 config.js 的 envId';
    } else if (/permission|denied|-502003/i.test(raw)) {
      hint = '云函数无调用权限，请检查云函数配置';
    }

    const err = makeError(50001, hint);
    err.raw = raw; // 保留原始信息，便于 console 定位
    console.error('[request] callFunction 失败:', name, action, raw);
    handleErrorCode(err, silent);
    throw err;
  } finally {
    if (loading) wx.hideLoading();
  }
}

function makeError(code, msg) {
  const err = new Error(msg);
  err.code = code;
  return err;
}

/** 统一错误处理：登录失效跳登录页，其他弹 toast */
function handleErrorCode(err, silent) {
  if (silent) return;

  if (err.code >= ERROR_NEED_LOGIN_MIN && err.code < ERROR_NEED_LOGIN_MAX) {
    const app = getApp();
    app.clearLogin();
    wx.navigateTo({ url: '/pages/login/login' });
    return;
  }

  wx.showToast({ title: err.msg || err.message, icon: 'none', duration: 2000 });
}

/**
 * 上传图片到云存储（客户端直传，不走云函数）
 * @param {string} localPath 本地临时路径
 * @param {string} dir       云存储目录，如 'products'
 * @returns {Promise<string>} fileID
 */
async function uploadImage(localPath, dir = 'products') {
  const ext = (localPath.split('.').pop() || 'jpg').split('?')[0];
  const openid = (getApp().globalData.userInfo || {})._id || 'anon';
  const cloudPath = `${dir}/${openid}/${Date.now()}-${Math.floor(Math.random() * 10000)}.${ext}`;

  const res = await wx.cloud.uploadFile({ cloudPath, filePath: localPath });
  return res.fileID;
}

module.exports = {
  call,
  uploadImage,
  ERROR_NEED_LOGIN_MIN,
  ERROR_NEED_LOGIN_MAX
};
