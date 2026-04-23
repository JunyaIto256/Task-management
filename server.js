const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const webpush = require('web-push');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── DB ──────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'tasks.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'other',
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'pending',
    due_date TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    notify_time TEXT DEFAULT '08:00'
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    task_id INTEGER,
    is_system INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS message_reads (
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    read_at TEXT DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (message_id, user_id)
  );
`);

// 既存テーブルへのカラム追加（マイグレーション）
const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
if (!taskCols.includes('created_by')) db.exec("ALTER TABLE tasks ADD COLUMN created_by INTEGER");

// ─── VAPID ───────────────────────────────────────────────────
let vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
let vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
if (!vapidPublicKey || !vapidPrivateKey) {
  const keys = webpush.generateVAPIDKeys();
  vapidPublicKey = keys.publicKey;
  vapidPrivateKey = keys.privateKey;
  console.log('VAPID_PUBLIC_KEY=' + vapidPublicKey);
  console.log('VAPID_PRIVATE_KEY=' + vapidPrivateKey);
}
webpush.setVapidDetails('mailto:example@example.com', vapidPublicKey, vapidPrivateKey);

// ─── 認証ミドルウェア ─────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'セッションが無効です。再登録してください。' });
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'トークンが無効です' });
  }
}

// ─── 認証API ─────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'ユーザー名とパスワードは必須です' });
  if (password.length < 6) return res.status(400).json({ error: 'パスワードは6文字以上必要です' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username))
    return res.status(400).json({ error: 'このユーザー名は既に使われています' });
  const hash = await bcrypt.hash(password, 10);
  const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  const token = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: result.lastInsertRowid, username } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username } });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username });
});

// ─── タスクAPI ────────────────────────────────────────────────
app.get('/api/tasks', auth, (req, res) => {
  const { date, category, status } = req.query;
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];
  if (date) { query += ' AND due_date LIKE ?'; params.push(date + '%'); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  query += ' ORDER BY priority DESC, due_date ASC';
  res.json(db.prepare(query).all(...params));
});

app.get('/api/tasks/month/:year/:month', auth, (req, res) => {
  const { year, month } = req.params;
  const prefix = `${year}-${month.padStart(2, '0')}`;
  res.json(db.prepare("SELECT * FROM tasks WHERE due_date LIKE ? ORDER BY due_date ASC").all(prefix + '%'));
});

app.post('/api/tasks', auth, (req, res) => {
  const { title, description, category, priority, due_date } = req.body;
  if (!title) return res.status(400).json({ error: 'タイトルは必須です' });
  const result = db.prepare(
    'INSERT INTO tasks (title, description, category, priority, due_date, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, description || '', category || 'other', priority || 'medium', due_date || null, req.user.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  const sys = db.prepare(
    'INSERT INTO messages (user_id, content, task_id, is_system) VALUES (?, ?, ?, 1)'
  ).run(req.user.id, `📋 ${req.user.username} がタスク「${title}」を作成しました`, result.lastInsertRowid);
  io.emit('message', getMsgWithMeta(sys.lastInsertRowid));
  res.json(task);
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const { title, description, category, priority, status, due_date } = req.body;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'タスクが見つかりません' });
  const prevStatus = task.status;
  db.prepare(
    `UPDATE tasks SET title=?, description=?, category=?, priority=?, status=?, due_date=?,
     updated_at=datetime('now','localtime') WHERE id=?`
  ).run(
    title ?? task.title, description ?? task.description, category ?? task.category,
    priority ?? task.priority, status ?? task.status, due_date ?? task.due_date, req.params.id
  );
  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (status && status !== prevStatus) {
    const labels = { pending: '未着手', 'in-progress': '進行中', completed: '完了' };
    const sys = db.prepare(
      'INSERT INTO messages (user_id, content, task_id, is_system) VALUES (?, ?, ?, 1)'
    ).run(req.user.id, `✅ ${req.user.username} がタスク「${updated.title}」を${labels[status] || status}にしました`, req.params.id);
    io.emit('message', getMsgWithMeta(sys.lastInsertRowid));
  }
  res.json(updated);
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'タスクが見つかりません' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  const sys = db.prepare(
    'INSERT INTO messages (user_id, content, is_system) VALUES (?, ?, 1)'
  ).run(req.user.id, `🗑 ${req.user.username} がタスク「${task.title}」を削除しました`);
  io.emit('message', getMsgWithMeta(sys.lastInsertRowid));
  res.json({ success: true });
});

app.get('/api/progress', auth, (req, res) => {
  const cats = ['work', 'household', 'leisure', 'research', 'other'];
  const result = {};
  cats.forEach(cat => {
    result[cat] = {
      total: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE category=?').get(cat).c,
      done: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE category=? AND status='completed'").get(cat).c
    };
  });
  result.all = {
    total: db.prepare('SELECT COUNT(*) as c FROM tasks').get().c,
    done: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='completed'").get().c
  };
  res.json(result);
});

// ─── メッセージAPI ────────────────────────────────────────────
function getMsgWithMeta(id) {
  const msg = db.prepare(`
    SELECT m.*, u.username,
      (SELECT COUNT(*) FROM message_reads WHERE message_id = m.id) as read_count
    FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?
  `).get(id);
  if (msg) msg.readers = db.prepare(`
    SELECT u.username FROM message_reads mr JOIN users u ON mr.user_id = u.id WHERE mr.message_id = ?
  `).all(id).map(r => r.username);
  return msg;
}

app.get('/api/messages', auth, (req, res) => {
  const messages = db.prepare(`
    SELECT m.*, u.username,
      (SELECT COUNT(*) FROM message_reads WHERE message_id = m.id) as read_count
    FROM messages m JOIN users u ON m.user_id = u.id
    ORDER BY m.created_at ASC LIMIT 300
  `).all();
  messages.forEach(msg => {
    msg.readers = db.prepare(`
      SELECT u.username FROM message_reads mr JOIN users u ON mr.user_id = u.id WHERE mr.message_id = ?
    `).all(msg.id).map(r => r.username);
  });
  const markRead = db.transaction(msgs => {
    const stmt = db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)');
    msgs.forEach(m => stmt.run(m.id, req.user.id));
  });
  markRead(messages);
  io.emit('bulk-read', { userId: req.user.id, username: req.user.username });
  res.json(messages);
});

app.post('/api/messages', auth, (req, res) => {
  const { content, taskId } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'メッセージを入力してください' });
  const result = db.prepare(
    'INSERT INTO messages (user_id, content, task_id) VALUES (?, ?, ?)'
  ).run(req.user.id, content.trim(), taskId || null);
  const msg = getMsgWithMeta(result.lastInsertRowid);
  if (!msg) return res.status(500).json({ error: 'メッセージの送信に失敗しました' });
  io.emit('message', msg);
  res.json(msg);
});

// ─── 通知API ──────────────────────────────────────────────────
app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: vapidPublicKey }));

app.post('/api/subscribe', auth, (req, res) => {
  const { subscription, notifyTime } = req.body;
  db.prepare(
    `INSERT INTO subscriptions (endpoint, p256dh, auth, notify_time) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, notify_time=excluded.notify_time`
  ).run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, notifyTime || '08:00');
  res.json({ success: true });
});

app.post('/api/unsubscribe', auth, (req, res) => {
  db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(req.body.endpoint);
  res.json({ success: true });
});

// ─── Socket.io ────────────────────────────────────────────────
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    next();
  } catch {
    next(new Error('認証エラー'));
  }
});

io.on('connection', socket => {
  socket.on('read-messages', ids => {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const stmt = db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)');
    db.transaction(arr => arr.forEach(id => stmt.run(id, socket.user.id)))(ids);
    io.emit('bulk-read', { userId: socket.user.id, username: socket.user.username });
  });
});

// ─── Cron ─────────────────────────────────────────────────────
cron.schedule('* * * * *', () => {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const todayStr = now.toISOString().split('T')[0];
  const subs = db.prepare('SELECT * FROM subscriptions WHERE notify_time = ?').all(time);
  subs.forEach(sub => {
    const tasks = db.prepare(
      "SELECT * FROM tasks WHERE due_date LIKE ? AND status != 'completed' ORDER BY priority DESC"
    ).all(todayStr + '%');
    const body = tasks.length > 0
      ? tasks.map(t => `・${t.title}（${{ high: '高', medium: '中', low: '低' }[t.priority]}）`).join('\n')
      : '今日の予定はありません';
    webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify({ title: '今日の予定', body, icon: '/icon.png' })
    ).catch(err => {
      if (err.statusCode === 410) db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(sub.endpoint);
    });
  });
});

httpServer.listen(PORT, '0.0.0.0', () => console.log(`サーバー起動中: http://0.0.0.0:${PORT}`));
