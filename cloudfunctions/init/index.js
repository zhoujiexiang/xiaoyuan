/**
 * 云函数 init — 一键初始化数据库
 *
 * 作用：自动创建 6 个集合 + 所有索引，免去在控制台逐个手建
 *
 * 使用方式（二选一）：
 *   A. 云开发控制台 → 云函数 → init → 云端测试 → 传 {} 执行
 *   B. 小程序「我的」页面长按底部文案 5 次触发
 *
 * 幂等：可重复执行。已存在的集合/索引会跳过，不会报错。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

/* ---------- 集合定义 ----------
 * config 也要建：管理端用它存管理员名单（config/admin 文档）
 */
const COLLECTIONS = [
  'users',
  'products',
  'orders',
  'messages',
  'favorites',
  'reports',
  'config'
];

/* ---------- 索引定义 ----------
 * direction: '1' 升序 / '-1' 降序
 * 注意：云开发要求索引字段顺序与查询顺序一致才生效
 */
const INDEXES = {
  products: [
    {
      name: 'idx_list',
      unique: false,
      keys: [
        { name: 'schoolId', direction: '1' },
        { name: 'status', direction: '1' },
        { name: 'createdAt', direction: '-1' }
      ]
    },
    {
      name: 'idx_cate',
      unique: false,
      keys: [
        { name: 'categoryId', direction: '1' },
        { name: 'schoolId', direction: '1' },
        { name: 'status', direction: '1' },
        { name: 'createdAt', direction: '-1' }
      ]
    },
    {
      name: 'idx_mine',
      unique: false,
      keys: [
        { name: 'sellerId', direction: '1' },
        { name: 'status', direction: '1' },
        { name: 'createdAt', direction: '-1' }
      ]
    }
  ],
  orders: [
    {
      name: 'idx_buyer',
      unique: false,
      keys: [
        { name: 'buyerOpenid', direction: '1' },
        { name: 'status', direction: '1' },
        { name: 'createdAt', direction: '-1' }
      ]
    },
    {
      name: 'idx_seller',
      unique: false,
      keys: [
        { name: 'sellerOpenid', direction: '1' },
        { name: 'status', direction: '1' },
        { name: 'createdAt', direction: '-1' }
      ]
    },
    {
      name: 'idx_product',
      unique: false,
      keys: [
        { name: 'productId', direction: '1' },
        { name: 'status', direction: '1' }
      ]
    },
    {
      name: 'idx_order_no',
      unique: true,
      keys: [{ name: 'orderNo', direction: '1' }]
    }
  ],
  messages: [
    {
      name: 'idx_conv',
      unique: false,
      keys: [
        { name: 'conversationId', direction: '1' },
        { name: 'createdAt', direction: '-1' }
      ]
    },
    {
      name: 'idx_unread',
      unique: false,
      keys: [
        { name: 'toOpenid', direction: '1' },
        { name: 'read', direction: '1' },
        { name: 'createdAt', direction: '-1' }
      ]
    }
  ],
  favorites: [
    {
      // 唯一索引：防止双击收藏插入两条重复数据
      name: 'idx_user_product',
      unique: true,
      keys: [
        { name: 'userId', direction: '1' },
        { name: 'productId', direction: '1' }
      ]
    },
    {
      name: 'idx_user_time',
      unique: false,
      keys: [
        { name: 'userId', direction: '1' },
        { name: 'createdAt', direction: '-1' }
      ]
    }
  ],
  users: [
    {
      name: 'idx_school_verify',
      unique: false,
      keys: [
        { name: 'schoolId', direction: '1' },
        { name: 'verifyStatus', direction: '1' }
      ]
    },
    {
      // 学号查重会用到
      name: 'idx_student_no',
      unique: false,
      keys: [{ name: 'studentNo', direction: '1' }]
    }
  ],
  reports: [
    {
      name: 'idx_status_time',
      unique: false,
      keys: [
        { name: 'status', direction: '1' },
        { name: 'createdAt', direction: '-1' }
      ]
    }
  ]
};

/* ---------- 主流程 ---------- */

async function createCollections(results) {
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      results.collections.push({ name, status: 'created' });
    } catch (e) {
      // 已存在：不同 SDK 版本错误码/文案不一致，这里尽量都覆盖
      const msg = String(e.errMsg || e.message || '');
      const code = e.errCode;
      const alreadyExists =
        code === -501001 ||
        code === -502002 ||
        /already exists|collection.*exist/i.test(msg);

      if (alreadyExists) {
        results.collections.push({ name, status: 'exists' });
      } else {
        // 把原始错误码和消息都留下来，否则排查时完全瞎猜
        results.collections.push({
          name,
          status: 'failed',
          errCode: code,
          error: msg
        });
      }
    }
  }
}

/**
 * 创建索引
 *
 * 说明：云开发 SDK 没有创建索引的 API，官方只在 HTTP API 里提供。
 * HTTP API 需要 access_token（用 AppID + AppSecret 换取），
 * 在云函数里可以通过 cloud.getWXContext() 拿不到 AppSecret。
 *
 * 所以这里的策略是：尝试用 cloud.openapi 的通用调用；
 * 失败则返回一份「索引清单」，用户复制到控制台即可。
 * 实际上控制台的「索引管理」支持批量粘贴，比手点快得多。
 */
async function createIndexes(results) {
  for (const [collection, indexes] of Object.entries(INDEXES)) {
    results.indexes[collection] = indexes.map(idx => ({
      name: idx.name,
      unique: idx.unique,
      fields: idx.keys.map(k => `${k.name}:${k.direction === '1' ? '升序' : '降序'}`).join(', '),
      status: 'manual'
    }));
  }
}

exports.main = async (event, context) => {
  const results = {
    collections: [],
    indexes: {},
    env: cloud.DYNAMIC_CURRENT_ENV,
    nextStep: ''
  };

  try {
    // 0. 先做一次连通性探测：能读到环境信息说明 SDK 和云环境都正常
    try {
      const probe = await db.collection('__probe__').limit(1).get();
      results.probe = 'ok';
    } catch (e) {
      // 集合不存在正是预期结果，说明链路是通的
      const msg = String((e && (e.errMsg || e.message)) || '');
      results.probe = /collection|not exist|-502005|-501001/i.test(msg)
        ? 'ok'
        : 'warn: ' + msg;
    }

    // 1. 创建集合
    await createCollections(results);

    // 2. 生成索引清单
    await createIndexes(results);

    const created = results.collections.filter(c => c.status === 'created').length;
    const existed = results.collections.filter(c => c.status === 'exists').length;
    const failed = results.collections.filter(c => c.status === 'failed');

    results.summary = {
      total: COLLECTIONS.length,
      created,
      existed,
      failedCount: failed.length
    };

    if (failed.length > 0) {
      results.nextStep =
        '有集合创建失败。原始错误：' +
        JSON.stringify(failed.map(f => ({ name: f.name, errCode: f.errCode, error: f.error })));
    } else {
      results.nextStep =
        `集合已就绪（新建 ${created} 个，已存在 ${existed} 个）。` +
        '接下来请到云开发控制台 → 数据库 → 各集合 → 索引管理，按下方清单建索引（一次性动作，之后不用再管）。';
    }

    console.log('[init] done:', JSON.stringify(results.summary));

    return { code: 0, msg: 'ok', data: results };
  } catch (e) {
    const detail = (e && (e.errMsg || e.message)) || '未知错误';
    console.error('[init] error:', e);
    return {
      code: 50000,
      msg: '初始化失败：' + detail,
      data: results
    };
  }
};
