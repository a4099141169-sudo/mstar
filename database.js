/**
 * SQLite 資料庫管理器 (Node 24 原生 node:sqlite)
 * 包含使用者帳號與權限、商品分類、商品庫存、訂單管理、系統設定 (Discord Webhook)
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);

// 初始化資料表結構
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    display_name TEXT NOT NULL,
    game_id TEXT,
    discord_id TEXT,
    role TEXT NOT NULL DEFAULT 'seller',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    icon TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    price_candy INTEGER NOT NULL DEFAULT 1,
    stock INTEGER NOT NULL DEFAULT 1,
    categories_json TEXT NOT NULL DEFAULT '[]',
    variants_json TEXT NOT NULL DEFAULT '[]',
    thumb_url TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL UNIQUE,
    seller_id INTEGER NOT NULL,
    seller_name TEXT NOT NULL,
    buyer_name TEXT,
    buyer_game_id TEXT,
    buyer_discord_id TEXT,
    buyer_gender TEXT,
    buyer_note TEXT,
    items_json TEXT NOT NULL,
    total_quantity INTEGER NOT NULL,
    total_candy INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// 初始化種子資料 (預設管理者改為 aya / aya123)
function initSeedData() {
  const now = new Date().toISOString();

  // 檢查是否已有 aya 帳號，若只有 admin 則更新為 aya
  const adminUser = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  if (adminUser) {
    db.prepare(`
      UPDATE users 
      SET username = 'aya', password = 'aya123', display_name = 'aya', updated_at = ? 
      WHERE id = ?
    `).run(now, adminUser.id);
  }

  const ayaUser = db.prepare("SELECT * FROM users WHERE username = 'aya'").get();
  if (!ayaUser) {
    const insertUser = db.prepare(`
      INSERT INTO users (username, password, display_name, game_id, discord_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertUser.run('aya', 'aya123', 'aya', 'aya', 'aya#0001', 'admin', now, now);
  }

  // 分類初始化
  const catCount = db.prepare('SELECT COUNT(*) as cnt FROM categories').get().cnt;
  if (catCount === 0) {
    const insertCat = db.prepare('INSERT INTO categories (name, icon, created_at) VALUES (?, ?, ?)');
    const defaultCats = [
      ['傢俱', '🛋️'],
      ['庭院造景', '🌲'],
      ['裝飾小物', '✨'],
      ['互動傢俱', '🎪'],
      ['壁紙地板', '🧱'],
      ['糖果特惠', '🍬']
    ];
    for (const [name, icon] of defaultCats) {
      insertCat.run(name, icon, now);
    }
  }

  // 乾淨商品種子初始化
  const prodCount = db.prepare('SELECT COUNT(*) as cnt FROM products').get().cnt;
  if (prodCount === 0) {
    const seller = db.prepare("SELECT id FROM users WHERE username = 'aya'").get();
    const sellerId = seller ? seller.id : 1;

    const insertProd = db.prepare(`
      INSERT INTO products 
      (user_id, title, price_candy, stock, categories_json, variants_json, thumb_url, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `);

    insertProd.run(
      sellerId,
      '森林帳篷',
      5,
      3,
      JSON.stringify(['傢俱', '庭院造景']),
      JSON.stringify([
        { id: 1, name: '粉紅', stock: 1 },
        { id: 2, name: '藍', stock: 2 }
      ]),
      'media/p89_d07141c1cdc04c48_t.webp',
      '超夢幻森林系雙人帳篷，支援野餐與休憩互動！',
      now,
      now
    );

    insertProd.run(
      sellerId,
      '巧克力愛心小屋·草莓',
      10,
      2,
      JSON.stringify(['傢俱', '裝飾小物']),
      JSON.stringify([]),
      'media/p88_c606f286c6e94dbf_t.webp',
      '充滿濃郁巧克力與草莓香氣的夢幻小屋。',
      now,
      now
    );

    insertProd.run(
      sellerId,
      '奇幻鼓',
      10,
      4,
      JSON.stringify(['互動傢俱', '裝飾小物']),
      JSON.stringify([
        { id: 3, name: '藍', stock: 2 },
        { id: 4, name: '黑', stock: 1 },
        { id: 5, name: '綠', stock: 1 }
      ]),
      'media/p85_fd0052f9fe424e73_t.webp',
      '敲擊會有絢麗音符與光效的奇幻節奏鼓。',
      now,
      now
    );

    insertProd.run(
      sellerId,
      '派對煙花',
      10,
      3,
      JSON.stringify(['庭院造景', '裝飾小物']),
      JSON.stringify([
        { id: 6, name: '雙子星', stock: 1 },
        { id: 7, name: '愛心', stock: 2 }
      ]),
      'media/p84_bf21bfdfdd654478_t.webp',
      '點燃後能釋放浪漫光芒的派對慶典煙花。',
      now,
      now
    );
  }
}

initSeedData();

// 資料庫操作方法封裝
const Database = {
  // --------------------------------------------------------------------------
  // 系統設定 (如 Discord Webhook)
  // --------------------------------------------------------------------------
  getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  setSetting(key, value) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    return value;
  },

  // --------------------------------------------------------------------------
  // 帳號與使用者驗證
  // --------------------------------------------------------------------------
  getUsers() {
    return db.prepare('SELECT id, username, password, display_name, game_id, discord_id, role, created_at, updated_at FROM users ORDER BY id ASC').all();
  },

  getUserById(id) {
    return db.prepare('SELECT id, username, password, display_name, game_id, discord_id, role, created_at, updated_at FROM users WHERE id = ?').get(id);
  },

  getUserByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  },

  login(username, password) {
    const user = this.getUserByUsername(username);
    if (!user) return null;
    if (user.password !== password) return null;
    const { password: _, ...safeUser } = user;
    return safeUser;
  },

  createUser({ username, password, display_name, game_id = null, discord_id = null, role = 'seller' }) {
    const now = new Date().toISOString();
    const res = db.prepare(`
      INSERT INTO users (username, password, display_name, game_id, discord_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      username.trim(),
      password.trim(),
      display_name.trim(),
      game_id ? game_id.trim() : null,
      discord_id ? discord_id.trim() : null,
      role || 'seller',
      now,
      now
    );
    return this.getUserById(res.lastInsertRowid);
  },

  updateUser(id, { password, display_name, game_id, discord_id, role }) {
    const current = this.getUserById(id);
    if (!current) return null;

    const now = new Date().toISOString();
    const newPwd = password !== undefined && password.trim() ? password.trim() : current.password;
    const newName = display_name !== undefined ? display_name.trim() : current.display_name;
    const newGameId = game_id !== undefined ? (game_id ? game_id.trim() : null) : current.game_id;
    const newDcId = discord_id !== undefined ? (discord_id ? discord_id.trim() : null) : current.discord_id;
    const newRole = role !== undefined ? role : current.role;

    db.prepare(`
      UPDATE users 
      SET password = ?, display_name = ?, game_id = ?, discord_id = ?, role = ?, updated_at = ?
      WHERE id = ?
    `).run(
      newPwd,
      newName,
      newGameId,
      newDcId,
      newRole,
      now,
      id
    );

    return this.getUserById(id);
  },

  deleteUser(id) {
    try {
      db.prepare('DELETE FROM products WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      return true;
    } catch (err) {
      console.error('deleteUser error:', err);
      throw err;
    }
  },

  getSellers() {
    return db.prepare('SELECT id, username, display_name as name, game_id, discord_id, role FROM users ORDER BY id ASC').all();
  },

  // --------------------------------------------------------------------------
  // 分類相關
  // --------------------------------------------------------------------------
  getCategories() {
    return db.prepare('SELECT * FROM categories ORDER BY id ASC').all();
  },

  createCategory({ name, icon = '🏷️' }) {
    const now = new Date().toISOString();
    try {
      const res = db.prepare('INSERT INTO categories (name, icon, created_at) VALUES (?, ?, ?)').run(
        name.trim(),
        icon || '🏷️',
        now
      );
      return db.prepare('SELECT * FROM categories WHERE id = ?').get(res.lastInsertRowid);
    } catch (e) {
      return db.prepare('SELECT * FROM categories WHERE name = ?').get(name.trim());
    }
  },

  // --------------------------------------------------------------------------
  // 商品相關
  // --------------------------------------------------------------------------
  getProducts({ category = '', search = '', seller_id = null, status = 'active' } = {}) {
    let sql = `
      SELECT p.*, u.display_name as seller_name, u.game_id as seller_game_id, u.discord_id as seller_discord_id 
      FROM products p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      sql += ' AND p.status = ?';
      params.push(status);
    }
    if (seller_id) {
      sql += ' AND p.user_id = ?';
      params.push(Number(seller_id));
    }
    if (search) {
      sql += ' AND (p.title LIKE ? OR p.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY p.id DESC';
    const rows = db.prepare(sql).all(...params);

    const list = rows.map(r => {
      let categories = [];
      let variants = [];
      try { categories = JSON.parse(r.categories_json || '[]'); } catch (e) {}
      try { variants = JSON.parse(r.variants_json || '[]'); } catch (e) {}

      return {
        id: r.id,
        title: r.title,
        price_candy: r.price_candy,
        stock: r.stock,
        categories,
        variants,
        thumb_url: r.thumb_url,
        description: r.description,
        status: r.status,
        created_at: r.created_at,
        updated_at: r.updated_at,
        seller: {
          id: r.user_id,
          name: r.seller_name || 'aya',
          username: r.seller_name || 'aya',
          display_name: r.seller_name || 'aya',
          game_id: r.seller_game_id,
          discord_id: r.seller_discord_id
        }
      };
    });

    if (category && category !== '全部') {
      return list.filter(item => item.categories.includes(category));
    }
    return list;
  },

  getProductById(id) {
    const r = db.prepare(`
      SELECT p.*, u.display_name as seller_name, u.game_id as seller_game_id, u.discord_id as seller_discord_id 
      FROM products p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `).get(id);

    if (!r) return null;
    let categories = [];
    let variants = [];
    try { categories = JSON.parse(r.categories_json || '[]'); } catch (e) {}
    try { variants = JSON.parse(r.variants_json || '[]'); } catch (e) {}

    return {
      id: r.id,
      title: r.title,
      price_candy: r.price_candy,
      stock: r.stock,
      categories,
      variants,
      thumb_url: r.thumb_url,
      description: r.description,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      seller: {
        id: r.user_id,
        name: r.seller_name || 'aya',
        username: r.seller_name || 'aya',
        display_name: r.seller_name || 'aya',
        game_id: r.seller_game_id,
        discord_id: r.seller_discord_id
      }
    };
  },

  createProduct({
    seller_id,
    title,
    price_candy = 1,
    stock = 1,
    categories = [],
    variants = [],
    thumb_url = null,
    description = ''
  }) {
    const now = new Date().toISOString();
    const res = db.prepare(`
      INSERT INTO products 
      (user_id, title, price_candy, stock, categories_json, variants_json, thumb_url, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      Number(seller_id),
      title.trim(),
      Number(price_candy),
      Number(stock),
      JSON.stringify(categories),
      JSON.stringify(variants),
      thumb_url,
      description ? description.trim() : null,
      now,
      now
    );

    return this.getProductById(res.lastInsertRowid);
  },

  deleteProduct(id) {
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    return true;
  },

  // --------------------------------------------------------------------------
  // 訂單相關
  // --------------------------------------------------------------------------
  createOrder({
    order_no,
    seller_id,
    seller_name,
    buyer_name = null,
    buyer_game_id = null,
    buyer_discord_id = null,
    buyer_gender = null,
    buyer_note = null,
    items = [],
    total_quantity = 0,
    total_candy = 0
  }) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO orders 
      (order_no, seller_id, seller_name, buyer_name, buyer_game_id, buyer_discord_id, buyer_gender, buyer_note, items_json, total_quantity, total_candy, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      order_no,
      Number(seller_id),
      seller_name,
      buyer_name,
      buyer_game_id,
      buyer_discord_id,
      buyer_gender,
      buyer_note,
      JSON.stringify(items),
      Number(total_quantity),
      Number(total_candy),
      now
    );

    return this.getOrderByNo(order_no);
  },

  getOrders() {
    const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
    return rows.map(r => ({
      ...r,
      items: JSON.parse(r.items_json || '[]')
    }));
  },

  getOrderByNo(orderNo) {
    const r = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
    if (!r) return null;
    return {
      ...r,
      items: JSON.parse(r.items_json || '[]')
    };
  },

  updateOrderStatus(idOrNo, status) {
    db.prepare('UPDATE orders SET status = ? WHERE id = ? OR order_no = ?').run(status, idOrNo, idOrNo);
    return true;
  }
};

module.exports = Database;
