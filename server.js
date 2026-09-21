/**
 * Mstar 糖果商城 - 全端伺服器 (Node.js + 原生 node:sqlite)
 * 包含：
 * 1. 靜態檔案與圖片上傳
 * 2. 身分驗證與防入侵機制（密碼打錯 3 次鎖定 30 秒）
 * 3. 帳號與密碼增刪改查
 * 4. 商品與訂單管理
 * 5. 購物車結帳自動推播 Discord Webhook 通知
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./database.js');

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// 防暴力破解登入鎖定 (In-memory)
// key: clientIp_or_username -> { count: number, lockUntil: number }
const loginAttempts = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload Too Large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

// 發送 Discord Webhook 通知工具
async function sendDiscordNotification(order, webhookUrl) {
  if (!webhookUrl || !webhookUrl.startsWith('http')) return;

  const itemsList = (order.items || []).map((it, idx) => {
    const v = it.variant_name ? ` (${it.variant_name})` : '';
    return `${idx + 1}. **${it.product_title}${v}** × ${it.quantity} 件 ＝ **${it.subtotal_candy}** 顆糖果`;
  }).join('\n');

  const buyerGenderStr = order.buyer_gender === 'male' ? '男角 ♂' : order.buyer_gender === 'female' ? '女角 ♀' : '未填';

  const embed = {
    title: '🍬【Mstar 糖果商城】收到新訂單！',
    description: `買家已在網站送出訂單，請依遊戲角色 ID 或 DC 聯絡買家完成糖果交易。`,
    color: 16727435, // 糖果粉色 #ff3d8b
    fields: [
      {
        name: '📋 訂單編號',
        value: `\`${order.order_no}\``,
        inline: true
      },
      {
        name: '👤 負責賣家',
        value: `${order.seller_name}`,
        inline: true
      },
      {
        name: '🎮 買家資料',
        value: [
          `• 稱呼：**${order.buyer_name || '未填'}** (${buyerGenderStr})`,
          `• 遊戲 ID：\`${order.buyer_game_id || '未填'}\``,
          `• Discord：\`${order.buyer_discord_id || '未填'}\``
        ].join('\n'),
        inline: false
      },
      {
        name: `📦 購買商品 (合計 ${order.total_quantity} 件)`,
        value: itemsList || '無品項',
        inline: false
      },
      {
        name: '🍬 糖果合計',
        value: `**${order.total_candy}** 顆糖果`,
        inline: true
      },
      {
        name: '📝 買家備註',
        value: order.buyer_note || '無備註',
        inline: true
      }
    ],
    footer: {
      text: 'Mstar 糖果商城 · 遊戲內直接交易'
    },
    timestamp: new Date().toISOString()
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `📢 收到來自買家 **${order.buyer_name || order.buyer_game_id || '訪客'}** 的新訂單！`,
        embeds: [embed]
      })
    });
    if (!res.ok) {
      console.error('Discord webhook responded with status:', res.status);
    }
  } catch (err) {
    console.error('Discord webhook push failed:', err.message);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const [rawPath, queryString] = req.url.split('?');
  const reqPath = decodeURIComponent(rawPath);
  const searchParams = new URLSearchParams(queryString || '');

  // 取得客戶端 IP (用於防暴力鎖定)
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown_ip';

  // --------------------------------------------------------------------------
  // 1. 身分驗證 (含密碼打錯 3 次鎖定 30 秒防護)
  // --------------------------------------------------------------------------
  if (reqPath === '/api/auth/login' && req.method === 'POST') {
    try {
      const { username, password } = await parseJsonBody(req);
      if (!username || !password) {
        return sendJson(res, 400, { error: '請輸入帳號與密碼' });
      }

      const lockKey = `${clientIp}_${username.trim().toLowerCase()}`;
      const now = Date.now();
      const attempt = loginAttempts.get(lockKey) || { count: 0, lockUntil: 0 };

      // 檢查是否處於鎖定時間內
      if (attempt.lockUntil > now) {
        const remaining = Math.ceil((attempt.lockUntil - now) / 1000);
        return sendJson(res, 429, {
          error: `密碼連續打錯 3 次，系統已暫時鎖定，請等待 ${remaining} 秒後再試`,
          remainingSeconds: remaining
        });
      }

      // 進行資料庫密碼比對
      const user = db.login(username, password);
      if (!user) {
        attempt.count += 1;
        if (attempt.count >= 3) {
          // 達到 3 次，鎖定 30 秒
          attempt.lockUntil = now + 30 * 1000;
          attempt.count = 0;
          loginAttempts.set(lockKey, attempt);
          return sendJson(res, 429, {
            error: '密碼連續打錯 3 次，系統已暫時鎖定 30 秒，請稍後再試',
            remainingSeconds: 30
          });
        } else {
          loginAttempts.set(lockKey, attempt);
          const chancesLeft = 3 - attempt.count;
          return sendJson(res, 401, {
            error: `帳號或密碼錯誤（剩餘 ${chancesLeft} 次機會，打錯 3 次將鎖定 30 秒）`
          });
        }
      }

      // 登入成功，清除失敗紀錄
      loginAttempts.delete(lockKey);
      return sendJson(res, 200, { success: true, user });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // --------------------------------------------------------------------------
  // 2. 帳號與密碼管理 API: GET, POST /api/users, PUT, DELETE /api/users/:id
  // --------------------------------------------------------------------------
  if (reqPath === '/api/users') {
    if (req.method === 'GET') {
      return sendJson(res, 200, db.getUsers());
    }
    if (req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (!body.username || !body.password || !body.display_name) {
          return sendJson(res, 400, { error: '帳號、密碼與顯示名稱為必填' });
        }
        const existing = db.getUserByUsername(body.username);
        if (existing) {
          return sendJson(res, 400, { error: '此帳號已被使用，請換一個' });
        }
        const created = db.createUser(body);
        return sendJson(res, 201, created);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }
  }

  const userMatch = reqPath.match(/^\/api\/users\/(\d+)$/);
  if (userMatch) {
    const userId = Number(userMatch[1]);
    if (req.method === 'PUT' || req.method === 'PATCH') {
      try {
        const body = await parseJsonBody(req);
        const updated = db.updateUser(userId, body);
        if (!updated) return sendJson(res, 404, { error: '找不到該使用者' });
        return sendJson(res, 200, updated);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }
    if (req.method === 'DELETE') {
      try {
        db.deleteUser(userId);
        return sendJson(res, 200, { success: true });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }
  }

  // --------------------------------------------------------------------------
  // 3. 系統設定 (Discord Webhook) API
  // --------------------------------------------------------------------------
  if (reqPath === '/api/settings') {
    if (req.method === 'GET') {
      const webhook = db.getSetting('discord_webhook_url') || '';
      return sendJson(res, 200, { discord_webhook_url: webhook });
    }
    if (req.method === 'POST') {
      try {
        const { discord_webhook_url } = await parseJsonBody(req);
        db.setSetting('discord_webhook_url', (discord_webhook_url || '').trim());
        return sendJson(res, 200, { success: true, discord_webhook_url: (discord_webhook_url || '').trim() });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }
  }

  // 測試發送 Discord 測試訊息: POST /api/test-discord
  if (reqPath === '/api/test-discord' && req.method === 'POST') {
    try {
      const { webhook_url } = await parseJsonBody(req);
      const targetUrl = webhook_url || db.getSetting('discord_webhook_url');
      if (!targetUrl) {
        return sendJson(res, 400, { error: '尚未填寫 Discord Webhook 網址' });
      }

      const testOrder = {
        order_no: 'OR-TEST01',
        seller_name: '測試賣家 (aya)',
        buyer_name: '測試買家小明',
        buyer_game_id: 'TestPlayer_01',
        buyer_discord_id: 'test#1234',
        buyer_gender: 'male',
        buyer_note: '這是一則測試通知，表示您的 Discord Webhook 串接完全正常！',
        total_quantity: 2,
        total_candy: 15,
        items: [
          { product_title: '森林雙人帳篷', variant_name: '粉紅', quantity: 1, subtotal_candy: 5 },
          { product_title: '巧克力愛心小屋', variant_name: null, quantity: 1, subtotal_candy: 10 }
        ]
      };

      await sendDiscordNotification(testOrder, targetUrl);
      return sendJson(res, 200, { success: true, message: '測試訊息已發送至 Discord 頻道！' });
    } catch (err) {
      return sendJson(res, 500, { error: '發送失敗: ' + err.message });
    }
  }

  // --------------------------------------------------------------------------
  // 4. 圖片上傳 API: POST /api/upload
  // --------------------------------------------------------------------------
  if (req.method === 'POST' && reqPath === '/api/upload') {
    try {
      const { filename, base64 } = await parseJsonBody(req);
      if (!base64) {
        return sendJson(res, 400, { error: '請提供圖片 base64 資料' });
      }

      const extMatch = base64.match(/^data:image\/([a-zA-Z0-9\+\-]+);base64,/);
      if (!extMatch) {
        return sendJson(res, 400, { error: '無效的圖片資料格式' });
      }

      const mimeSubtype = extMatch[1].toLowerCase();
      const allowedSubtypes = new Set(['png', 'jpeg', 'jpg', 'webp', 'gif']);
      if (!allowedSubtypes.has(mimeSubtype)) {
        return sendJson(res, 400, { error: '不支援的圖片格式，請使用 PNG、JPG、WebP 或 GIF' });
      }

      const ext = mimeSubtype === 'jpeg' ? '.jpg' : '.' + mimeSubtype;
      const pureBase64 = base64.replace(/^data:image\/[a-zA-Z0-9\+\-]+;base64,/, '');
      const imageBuffer = Buffer.from(pureBase64, 'base64');

      // 前端已先壓縮；伺服器仍保留 10MB 成品上限，避免異常大檔直接落盤。
      if (imageBuffer.length > 10 * 1024 * 1024) {
        return sendJson(res, 413, { error: '圖片檔案過大，請重新選擇圖片' });
      }

      const randomName = 'img_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8) + ext;
      const destPath = path.join(UPLOADS_DIR, randomName);
      fs.writeFileSync(destPath, imageBuffer);

      return sendJson(res, 200, {
        success: true,
        url: 'uploads/' + randomName
      });
    } catch (err) {
      return sendJson(res, 500, { error: '圖片上傳失敗: ' + err.message });
    }
  }

  // --------------------------------------------------------------------------
  // 5. 賣家清單 API: GET /api/sellers
  // --------------------------------------------------------------------------
  if (reqPath === '/api/sellers') {
    if (req.method === 'GET') {
      return sendJson(res, 200, db.getSellers());
    }
  }

  // --------------------------------------------------------------------------
  // 6. 分類清單 API: GET /api/categories & POST /api/categories
  // --------------------------------------------------------------------------
  if (reqPath === '/api/categories') {
    if (req.method === 'GET') {
      return sendJson(res, 200, db.getCategories());
    }
    if (req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (!body.name || !body.name.trim()) {
          return sendJson(res, 400, { error: '分類名稱為必填' });
        }
        const created = db.createCategory(body);
        return sendJson(res, 201, created);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }
  }

  // --------------------------------------------------------------------------
  // 7. 商品 API: GET /api/products, POST /api/products, DELETE /api/products/:id
  // --------------------------------------------------------------------------
  if (reqPath === '/api/products') {
    if (req.method === 'GET') {
      const category = searchParams.get('category') || '';
      const search = searchParams.get('search') || '';
      const seller_id = searchParams.get('seller_id') || null;
      const list = db.getProducts({ category, search, seller_id });
      return sendJson(res, 200, list);
    }
    if (req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (!body.title || !body.title.trim()) {
          return sendJson(res, 400, { error: '商品名稱為必填' });
        }
        if (!body.seller_id) {
          return sendJson(res, 400, { error: '請指定賣家' });
        }
        const product = db.createProduct(body);
        return sendJson(res, 201, product);
      } catch (err) {
        return sendJson(res, 500, { error: '上架失敗: ' + err.message });
      }
    }
  }

  const prodMatch = reqPath.match(/^\/api\/products\/(\d+)$/);
  if (prodMatch) {
    const prodId = Number(prodMatch[1]);
    if (req.method === 'DELETE') {
      db.deleteProduct(prodId);
      return sendJson(res, 200, { success: true });
    }
  }

  // --------------------------------------------------------------------------
  // 8. 訂單相關 API: GET /api/orders, POST /api/orders (自動推播 Discord)
  // --------------------------------------------------------------------------
  if (reqPath === '/api/orders') {
    if (req.method === 'GET') {
      return sendJson(res, 200, db.getOrders());
    }
    if (req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const orderList = Array.isArray(body.orders) ? body.orders : [body];
        const savedOrders = [];
        const webhookUrl = db.getSetting('discord_webhook_url');

        for (const o of orderList) {
          const randSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
          const orderNo = o.order_no || `OR-${Date.now().toString().slice(-6)}${randSuffix}`;
          
          const created = db.createOrder({
            order_no: orderNo,
            seller_id: o.seller_id,
            seller_name: o.seller_name,
            buyer_name: o.buyer_name,
            buyer_game_id: o.buyer_game_id,
            buyer_discord_id: o.buyer_discord_id,
            buyer_gender: o.buyer_gender,
            buyer_note: o.buyer_note,
            items: o.items || [],
            total_quantity: o.total_quantity || 0,
            total_candy: o.total_candy || 0
          });
          savedOrders.push(created);

          // 異步發送 Discord 通知 (不阻塞訂單回應)
          if (webhookUrl) {
            sendDiscordNotification(created, webhookUrl).catch(e => console.error('Webhook error:', e));
          }
        }

        return sendJson(res, 201, { success: true, orders: savedOrders });
      } catch (err) {
        return sendJson(res, 500, { error: '建立訂單失敗: ' + err.message });
      }
    }
  }

  const orderStatusMatch = reqPath.match(/^\/api\/orders\/([a-zA-Z0-9\-_]+)\/status$/);
  if (orderStatusMatch && req.method === 'PATCH') {
    try {
      const orderNo = orderStatusMatch[1];
      const { status } = await parseJsonBody(req);
      db.updateOrderStatus(orderNo, status);
      return sendJson(res, 200, { success: true });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // --------------------------------------------------------------------------
  // 靜態檔案託管
  // --------------------------------------------------------------------------
  let staticPath = reqPath;
  if (staticPath === '/' || staticPath === '/cart' || staticPath === '/shop' || staticPath === '/admin') {
    staticPath = '/index.html';
  }

  let filePath = path.join(__dirname, staticPath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      if (!path.extname(filePath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + reqPath);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

process.on('uncaughtException', (err) => {
  console.error('[Global Error Catch]', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection]', reason);
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`✨ Mstar 糖果商城 全端前後台與帳號登入系統已啟動:`);
  console.log(`👉 瀏覽網址: http://localhost:${PORT}/`);
  console.log(`💾 資料庫檔案: ${path.join(__dirname, 'data.db')}`);
  console.log(`🔑 預設管理員: aya / aya123`);
  console.log(`🛡️ 密碼防護: 連續打錯 3 次自動鎖定 30 秒`);
  console.log(`🔔 支援 Discord Webhook 新訂單即時推播通知`);
  console.log(`======================================================\n`);
});
