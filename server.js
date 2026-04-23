const express = require('express');
const Database = require('better-sqlite3');
const webpush = require('web-push');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// DB初期化
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
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// VAPID設定
let vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
let vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

if (!vapidPublicKey || !vapidPrivateKey) {
  const keys = webpush.generateVAPIDKeys();
  vapidPublicKey = keys.publicKey;
  vapidPrivateKey = keys.privateKey;
  console.log('生成されたVAPIDキー（.envに保存推奨）:');
  console.log('VAPID_PUBLIC_KEY=' + vapidPublicKey);
  console.log('VAPID_PRIVATE_KEY=' + vapidPrivateKey);
}

webpush.setVapidDetails('mailto:example@example.com', vapidPublicKey, vapidPrivateKey);

// ─── タスクAPI ──────────────────────────────────────────

app.get('/api/tasks', (req, res) => {
  const { date, category, status } = req.query;
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (date) {
    query += ' AND due_date LIKE ?';
    params.push(date + '%');
  }
  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }
  query += ' ORDER BY priority DESC, due_date ASC';

  res.json(db.prepare(query).all(...params));
});

app.post('/api/tasks', (req, res) => {
  const { title, description, category, priority, due_date } = req.body;
  if (!title) return res.status(400).json({ error: 'タイトルは必須です' });

  const result = db.prepare(
    `INSERT INTO tasks (title, description, category, priority, due_date)
     VALUES (?, ?, ?, ?, ?)`
  ).run(title, description || '', category || 'other', priority || 'medium', due_date || null);

  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/tasks/:id', (req, res) => {
  const { title, description, category, priority, status, due_date } = req.body;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'タスクが見つかりません' });

  db.prepare(
    `UPDATE tasks SET title=?, description=?, category=?, priority=?, status=?, due_date=?,
     updated_at=datetime('now','localtime') WHERE id=?`
  ).run(
    title ?? task.title,
    description ?? task.description,
    category ?? task.category,
    priority ?? task.priority,
    status ?? task.status,
    due_date ?? task.due_date,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id));
});

app.delete('/api/tasks/:id', (req, res) => {
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'タスクが見つかりません' });
  res.json({ success: true });
});

// ─── 進捗API ────────────────────────────────────────────

app.get('/api/progress', (req, res) => {
  const categories = ['work', 'household', 'leisure', 'research', 'other'];
  const result = {};

  for (const cat of categories) {
    const total = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE category=?').get(cat).c;
    const done = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE category=? AND status='completed'").get(cat).c;
    result[cat] = { total, done };
  }

  const allTotal = db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
  const allDone = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='completed'").get().c;
  result.all = { total: allTotal, done: allDone };

  res.json(result);
});

// ─── 通知API ────────────────────────────────────────────

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidPublicKey });
});

app.post('/api/subscribe', (req, res) => {
  const { subscription, notifyTime } = req.body;
  const { endpoint, keys } = subscription;

  db.prepare(
    `INSERT INTO subscriptions (endpoint, p256dh, auth, notify_time)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, notify_time=excluded.notify_time`
  ).run(endpoint, keys.p256dh, keys.auth, notifyTime || '08:00');

  res.json({ success: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(endpoint);
  res.json({ success: true });
});

// ─── 朝の定時通知（毎分チェック）────────────────────────

cron.schedule('* * * * *', () => {
  const now = new Date();
  const currentTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const today = now.toISOString().split('T')[0];

  const subs = db.prepare('SELECT * FROM subscriptions WHERE notify_time = ?').all(currentTime);

  for (const sub of subs) {
    const todayTasks = db.prepare(
      "SELECT * FROM tasks WHERE due_date LIKE ? AND status != 'completed' ORDER BY priority DESC"
    ).all(today + '%');

    const taskList = todayTasks.length > 0
      ? todayTasks.map(t => `・${t.title}（${priorityLabel(t.priority)}）`).join('\n')
      : '今日の予定はありません';

    const payload = JSON.stringify({
      title: '今日の予定',
      body: taskList,
      icon: '/icon.png',
      badge: '/icon.png'
    });

    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };

    webpush.sendNotification(pushSub, payload).catch(err => {
      if (err.statusCode === 410) {
        db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(sub.endpoint);
      }
    });
  }
});

function priorityLabel(p) {
  return { high: '高', medium: '中', low: '低' }[p] || p;
}

// ─── カレンダー用：月のタスク取得 ────────────────────────

app.get('/api/tasks/month/:year/:month', (req, res) => {
  const { year, month } = req.params;
  const prefix = `${year}-${month.padStart(2, '0')}`;
  const tasks = db.prepare(
    "SELECT * FROM tasks WHERE due_date LIKE ? ORDER BY due_date ASC"
  ).all(prefix + '%');
  res.json(tasks);
});

app.listen(PORT, () => {
  console.log(`タスク管理サーバー起動中: http://localhost:${PORT}`);
});
