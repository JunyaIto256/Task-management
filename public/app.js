// ─── 定数 ────────────────────────────────────────────────────
const CAT_LABELS = { work: '仕事', household: '家事', leisure: '遊び', research: '研究', other: 'その他' };
const PRI_LABELS = { high: '高', medium: '中', low: '低' };
const STA_LABELS = { pending: '未着手', 'in-progress': '進行中', completed: '完了' };
const CAT_COLORS = { work: '#3b82f6', household: '#10b981', leisure: '#f59e0b', research: '#8b5cf6', other: '#6b7280' };

const $ = id => document.getElementById(id);
const today = () => new Date().toISOString().split('T')[0];
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── 認証状態 ────────────────────────────────────────────────
let currentUser = null;
let socket = null;
let unreadCount = 0;

function getToken() { return localStorage.getItem('token'); }
function setToken(t) { localStorage.setItem('token', t); }
function clearToken() { localStorage.removeItem('token'); }

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  const token = getToken();
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  if (res.status === 401) { logout(); throw new Error('認証が必要です'); }
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function showApp(user) {
  currentUser = user;
  $('auth-overlay').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('current-user').textContent = `${user.username} さん`;
  initSocket();
  renderCalendar();
  initNotifications();
}

function logout() {
  clearToken();
  currentUser = null;
  if (socket) { socket.disconnect(); socket = null; }
  $('app').classList.add('hidden');
  $('auth-overlay').classList.remove('hidden');
}

$('logout-btn').addEventListener('click', logout);

// ─── 認証フォーム ─────────────────────────────────────────────
document.querySelectorAll('.auth-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $('login-form').classList.toggle('hidden', tab !== 'login');
    $('register-form').classList.toggle('hidden', tab !== 'register');
    $('auth-error').classList.add('hidden');
  });
});

function showAuthError(msg) {
  $('auth-error').textContent = msg;
  $('auth-error').classList.remove('hidden');
}

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: $('login-username').value, password: $('login-password').value })
  });
  const data = await res.json();
  if (!res.ok) return showAuthError(data.error);
  setToken(data.token);
  showApp(data.user);
});

$('register-form').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: $('reg-username').value, password: $('reg-password').value })
  });
  const data = await res.json();
  if (!res.ok) return showAuthError(data.error);
  setToken(data.token);
  showApp(data.user);
});

// ─── ナビゲーション ─────────────────────────────────────────
let currentView = 'calendar';

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); });
    btn.classList.add('active');
    $(`view-${view}`).classList.remove('hidden');
    $(`view-${view}`).classList.add('active');
    currentView = view;
    if (view === 'tasks') loadTasks();
    if (view === 'progress') loadProgress();
    if (view === 'chat') {
      unreadCount = 0;
      $('chat-badge').classList.add('hidden');
      loadMessages();
    }
  });
});

// ─── カレンダー ─────────────────────────────────────────────
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();
let selectedDate = null;

function renderCalendar() {
  $('calendar-title').textContent = `${calYear}年${calMonth + 1}月`;
  const grid = $('calendar-grid');
  grid.innerHTML = '';
  ['日','月','火','水','木','金','土'].forEach((d, i) => {
    const el = document.createElement('div');
    el.className = 'cal-day-label' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '');
    el.textContent = d;
    grid.appendChild(el);
  });
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const daysInPrev = new Date(calYear, calMonth, 0).getDate();
  const todayStr = today();

  api('GET', `/tasks/month/${calYear}/${String(calMonth + 1).padStart(2, '0')}`).then(tasks => {
    const taskMap = {};
    tasks.forEach(t => {
      const d = t.due_date ? t.due_date.split('T')[0] : null;
      if (d) { if (!taskMap[d]) taskMap[d] = []; taskMap[d].push(t); }
    });
    for (let i = 0; i < firstDay; i++)
      grid.appendChild(makeCell(calYear, calMonth - 1 < 0 ? 11 : calMonth - 1, daysInPrev - firstDay + i + 1, true, taskMap, todayStr));
    for (let d = 1; d <= daysInMonth; d++)
      grid.appendChild(makeCell(calYear, calMonth, d, false, taskMap, todayStr));
    let after = 1;
    while ((firstDay + daysInMonth + after - 1) % 7 !== 0) {
      grid.appendChild(makeCell(calYear, calMonth + 1 > 11 ? 0 : calMonth + 1, after, true, taskMap, todayStr));
      after++;
    }
  });
}

function makeCell(year, month, day, otherMonth, taskMap, todayStr) {
  const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const dow = new Date(year, month, day).getDay();
  const cell = document.createElement('div');
  cell.className = 'cal-cell' +
    (otherMonth ? ' other-month' : '') +
    (dateStr === todayStr ? ' today' : '') +
    (dateStr === selectedDate ? ' selected' : '') +
    (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '');
  const dateEl = document.createElement('div');
  dateEl.className = 'cal-date';
  dateEl.textContent = day;
  cell.appendChild(dateEl);
  (taskMap[dateStr] || []).slice(0, 3).forEach(t => {
    const dot = document.createElement('span');
    dot.className = 'cal-dot';
    dot.style.background = CAT_COLORS[t.category] || '#999';
    dot.title = t.title;
    cell.appendChild(dot);
  });
  const extra = (taskMap[dateStr] || []).length - 3;
  if (extra > 0) {
    const s = document.createElement('span');
    s.style.cssText = 'font-size:.65rem;color:#64748b;';
    s.textContent = `+${extra}`;
    cell.appendChild(s);
  }
  cell.addEventListener('click', () => {
    selectedDate = otherMonth ? null : dateStr;
    renderCalendar();
    if (!otherMonth) showDayTasks(dateStr);
  });
  return cell;
}

function showDayTasks(dateStr) {
  const panel = $('day-tasks-panel');
  panel.classList.remove('hidden');
  $('day-tasks-title').textContent = `${dateStr} のタスク`;
  $('add-from-calendar').onclick = () => openModal(null, dateStr);
  api('GET', `/tasks?date=${dateStr}`).then(tasks => {
    const list = $('day-tasks-list');
    list.innerHTML = '';
    if (!tasks.length) { list.innerHTML = '<p style="color:#64748b;font-size:.88rem;">タスクなし</p>'; return; }
    tasks.forEach(t => list.appendChild(makeTaskCard(t, true)));
  });
}

$('prev-month').addEventListener('click', () => {
  calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; }
  selectedDate = null; $('day-tasks-panel').classList.add('hidden'); renderCalendar();
});
$('next-month').addEventListener('click', () => {
  calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; }
  selectedDate = null; $('day-tasks-panel').classList.add('hidden'); renderCalendar();
});

// ─── タスク一覧 ─────────────────────────────────────────────
async function loadTasks() {
  const cat = $('filter-category').value;
  const sta = $('filter-status').value;
  const qs = [];
  if (cat) qs.push(`category=${cat}`);
  if (sta) qs.push(`status=${sta}`);
  const tasks = await api('GET', '/tasks' + (qs.length ? '?' + qs.join('&') : ''));
  const list = $('task-list');
  list.innerHTML = '';
  if (!tasks.length) { list.innerHTML = '<p style="color:#64748b;text-align:center;padding:30px;">タスクがありません</p>'; return; }
  tasks.forEach(t => list.appendChild(makeTaskCard(t, false)));
}

$('filter-category').addEventListener('change', loadTasks);
$('filter-status').addEventListener('change', loadTasks);
$('open-add-modal').addEventListener('click', () => openModal());

function makeTaskCard(task, compact) {
  const card = document.createElement('div');
  card.className = `task-card cat-${task.category}` + (task.status === 'completed' ? ' completed' : '');
  const check = document.createElement('div');
  check.className = 'task-check' + (task.status === 'completed' ? ' done' : '');
  check.innerHTML = task.status === 'completed' ? '&#10003;' : '';
  check.title = task.status === 'completed' ? '未完了に戻す' : '完了にする';
  check.addEventListener('click', async () => {
    await api('PUT', `/tasks/${task.id}`, { status: task.status === 'completed' ? 'pending' : 'completed' });
    if (currentView === 'tasks') loadTasks();
    else if (selectedDate) showDayTasks(selectedDate);
    renderCalendar();
  });
  const body = document.createElement('div');
  body.className = 'task-body';
  body.innerHTML = `<div class="task-title">${escHtml(task.title)}</div>`;
  if (task.description && !compact) body.innerHTML += `<div class="task-desc">${escHtml(task.description)}</div>`;
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  meta.innerHTML = `
    <span class="badge badge-cat-${task.category}">${CAT_LABELS[task.category] || task.category}</span>
    <span class="badge badge-priority-${task.priority}">${PRI_LABELS[task.priority] || task.priority}</span>
    <span class="badge badge-status-${task.status}">${STA_LABELS[task.status] || task.status}</span>
  `;
  if (task.due_date) {
    const due = task.due_date.split('T')[0];
    const overdue = due < today() && task.status !== 'completed';
    meta.innerHTML += `<span class="task-due${overdue ? ' overdue' : ''}">${overdue ? '期限切れ: ' : '期日: '}${due}</span>`;
  }
  body.appendChild(meta);
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  const editBtn = document.createElement('button');
  editBtn.className = 'btn-icon'; editBtn.title = '編集'; editBtn.textContent = '✏';
  editBtn.addEventListener('click', () => openModal(task));
  const delBtn = document.createElement('button');
  delBtn.className = 'btn-icon danger'; delBtn.title = '削除'; delBtn.textContent = '✕';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`「${task.title}」を削除しますか？`)) return;
    await api('DELETE', `/tasks/${task.id}`);
    if (currentView === 'tasks') loadTasks();
    else if (selectedDate) showDayTasks(selectedDate);
    renderCalendar();
  });
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  card.appendChild(check); card.appendChild(body); card.appendChild(actions);
  return card;
}

// ─── 進捗 ─────────────────────────────────────────────────
async function loadProgress() {
  const data = await api('GET', '/progress');
  const overall = data.all;
  const pct = overall.total === 0 ? 0 : Math.round((overall.done / overall.total) * 100);
  $('progress-overall').innerHTML = `
    <div class="progress-big">
      <div class="pct">${pct}%</div>
      <div style="font-size:.9rem;color:#64748b;margin-bottom:10px;">全タスク完了率（${overall.done}/${overall.total}件）</div>
    </div>
    <div class="progress-bar-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
  `;
  const charts = $('progress-charts');
  charts.innerHTML = '';
  [['work','仕事'],['household','家事'],['leisure','遊び'],['research','研究'],['other','その他']].forEach(([cat, label]) => {
    const d = data[cat];
    const p = d.total === 0 ? 0 : Math.round((d.done / d.total) * 100);
    const card = document.createElement('div');
    card.className = `progress-card cat-${cat}`;
    card.innerHTML = `
      <h3>${label}</h3>
      <div class="progress-nums">${d.done} / ${d.total} 件完了</div>
      <div class="progress-bar-wrap"><div class="progress-bar" style="width:${p}%;background:${CAT_COLORS[cat]}"></div></div>
      <div style="font-size:.8rem;color:#64748b;margin-top:4px;">${p}%</div>
    `;
    charts.appendChild(card);
  });
}

// ─── モーダル ─────────────────────────────────────────────
function openModal(task = null, preDate = null) {
  $('modal-title').textContent = task ? 'タスク編集' : 'タスク追加';
  $('task-id').value = task ? task.id : '';
  $('f-title').value = task ? task.title : '';
  $('f-description').value = task ? task.description : '';
  $('f-category').value = task ? task.category : 'other';
  $('f-priority').value = task ? task.priority : 'medium';
  $('f-status').value = task ? task.status : 'pending';
  $('f-due-date').value = task ? (task.due_date ? task.due_date.split('T')[0] : '') : (preDate || '');
  $('modal-overlay').classList.remove('hidden');
  setTimeout(() => $('f-title').focus(), 50);
}

$('close-modal').addEventListener('click', () => $('modal-overlay').classList.add('hidden'));
$('modal-overlay').addEventListener('click', e => { if (e.target === $('modal-overlay')) $('modal-overlay').classList.add('hidden'); });

$('task-form').addEventListener('submit', async e => {
  e.preventDefault();
  const id = $('task-id').value;
  const body = {
    title: $('f-title').value.trim(),
    description: $('f-description').value.trim(),
    category: $('f-category').value,
    priority: $('f-priority').value,
    status: $('f-status').value,
    due_date: $('f-due-date').value || null,
  };
  if (id) await api('PUT', `/tasks/${id}`, body);
  else await api('POST', '/tasks', body);
  $('modal-overlay').classList.add('hidden');
  if (currentView === 'tasks') loadTasks();
  else if (selectedDate) showDayTasks(selectedDate);
  renderCalendar();
});

// ─── チャット ─────────────────────────────────────────────
let chatMessages = [];

async function loadMessages() {
  chatMessages = await api('GET', '/messages');
  renderMessages();
  scrollChatBottom();
}

function renderMessages() {
  const container = $('chat-messages');
  container.innerHTML = '';
  chatMessages.forEach(msg => container.appendChild(makeMsgEl(msg)));
}

function makeMsgEl(msg) {
  const isMe = currentUser && msg.user_id === currentUser.id;
  const isSystem = msg.is_system === 1;

  if (isSystem) {
    const row = document.createElement('div');
    row.className = 'msg-row system';
    row.dataset.id = msg.id;
    const bubble = document.createElement('div');
    bubble.className = 'msg-system-bubble';
    bubble.textContent = msg.content;
    row.appendChild(bubble);
    return row;
  }

  const row = document.createElement('div');
  row.className = 'msg-row' + (isMe ? ' mine' : '');
  row.dataset.id = msg.id;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = msg.username.charAt(0).toUpperCase();
  avatar.style.background = stringToColor(msg.username);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'msg-body';

  if (!isMe) {
    const name = document.createElement('div');
    name.className = 'msg-name';
    name.textContent = msg.username;
    bodyEl.appendChild(name);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = msg.content;
  bodyEl.appendChild(bubble);

  const footer = document.createElement('div');
  footer.className = 'msg-footer';

  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = formatTime(msg.created_at);
  footer.appendChild(time);

  // 既読ボタン
  const readBtn = document.createElement('button');
  readBtn.className = 'read-count';
  readBtn.dataset.msgId = msg.id;
  updateReadBtn(readBtn, msg);
  readBtn.addEventListener('click', e => showReadersPopup(e, msg));
  footer.appendChild(readBtn);

  // タスク作成ボタン
  const taskBtn = document.createElement('button');
  taskBtn.className = 'task-link-btn';
  taskBtn.textContent = '📋 タスク化';
  taskBtn.addEventListener('click', () => {
    openModal(null, null);
    $('f-title').value = msg.content.slice(0, 50);
  });
  footer.appendChild(taskBtn);

  bodyEl.appendChild(footer);
  row.appendChild(avatar);
  row.appendChild(bodyEl);
  return row;
}

function updateReadBtn(btn, msg) {
  const count = msg.read_count || (msg.readers ? msg.readers.length : 0);
  btn.textContent = count > 0 ? `既読 ${count}人` : '既読 0';
}

function showReadersPopup(e, msg) {
  const popup = $('readers-popup');
  const list = $('readers-list');
  list.innerHTML = '';
  const readers = msg.readers || [];
  if (readers.length === 0) {
    list.innerHTML = '<div class="reader-name" style="color:#94a3b8;">まだ誰も読んでいません</div>';
  } else {
    readers.forEach(name => {
      const d = document.createElement('div');
      d.className = 'reader-name';
      d.textContent = name;
      list.appendChild(d);
    });
  }
  popup.style.left = Math.min(e.clientX, window.innerWidth - 150) + 'px';
  popup.style.top = (e.clientY + 10) + 'px';
  popup.classList.remove('hidden');
  const close = ev => { if (!popup.contains(ev.target)) { popup.classList.add('hidden'); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
  e.stopPropagation();
}

function scrollChatBottom(smooth = false) {
  const container = $('chat-messages');
  container.scrollTo({ top: container.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

// チャット送信
async function sendMessage() {
  const input = $('chat-input');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  input.style.height = 'auto';
  await api('POST', '/messages', { content });
}

$('chat-send').addEventListener('click', sendMessage);
$('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$('chat-input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// ─── Socket.io ───────────────────────────────────────────
function initSocket() {
  socket = io({ auth: { token: getToken() } });

  socket.on('message', msg => {
    if (!msg || !msg.id) return;
    const exists = chatMessages.find(m => m.id === msg.id);
    if (!exists) {
      chatMessages.push(msg);
      if (currentView === 'chat') {
        $('chat-messages').appendChild(makeMsgEl(msg));
        scrollChatBottom(true);
        // 受信したメッセージを既読にする
        if (msg.user_id !== currentUser?.id) socket.emit('read-messages', [msg.id]);
      } else {
        unreadCount++;
        const badge = $('chat-badge');
        badge.textContent = unreadCount;
        badge.classList.remove('hidden');
      }
    }
    if (currentView === 'calendar') renderCalendar();
  });

  socket.on('bulk-read', ({ userId, username }) => {
    chatMessages.forEach(msg => {
      if (!msg || !msg.readers) { if (msg) msg.readers = []; else return; }
      if (!msg.readers.includes(username)) {
        msg.readers.push(username);
        msg.read_count = msg.readers.length;
      }
    });
    if (currentView === 'chat') {
      document.querySelectorAll('.read-count[data-msg-id]').forEach(btn => {
        const id = parseInt(btn.dataset.msgId);
        const msg = chatMessages.find(m => m.id === id);
        if (msg) updateReadBtn(btn, msg);
      });
    }
  });

  socket.on('connect_error', err => {
    console.error('Socket接続エラー:', err.message);
  });
}

// ─── プッシュ通知 ────────────────────────────────────────
let swRegistration = null;

async function initNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    $('subscribe-btn').textContent = '通知未対応';
    $('subscribe-btn').disabled = true;
    return;
  }
  swRegistration = await navigator.serviceWorker.register('/sw.js');
  const sub = await swRegistration.pushManager.getSubscription();
  updateNotifyBtn(!!sub);
}

function updateNotifyBtn(subscribed) {
  const btn = $('subscribe-btn');
  btn.textContent = subscribed ? '通知を無効化' : '通知を有効化';
  btn.dataset.subscribed = subscribed ? '1' : '0';
}

$('subscribe-btn').addEventListener('click', async () => {
  if ($('subscribe-btn').dataset.subscribed === '1') {
    const sub = await swRegistration.pushManager.getSubscription();
    if (sub) { await sub.unsubscribe(); await api('POST', '/unsubscribe', { endpoint: sub.endpoint }); }
    updateNotifyBtn(false);
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { alert('通知の許可が必要です'); return; }
  const { publicKey } = await api('GET', '/vapid-public-key');
  const sub = await swRegistration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });
  await api('POST', '/subscribe', { subscription: sub.toJSON(), notifyTime: $('notify-time').value });
  updateNotifyBtn(true);
  alert(`通知を有効化しました。毎朝 ${$('notify-time').value} に今日の予定をお知らせします。`);
});

function urlBase64ToUint8Array(b) {
  const p = '='.repeat((4 - b.length % 4) % 4);
  const s = atob((b + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...s].map(c => c.charCodeAt(0)));
}

// ─── ユーティリティ ──────────────────────────────────────
function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const colors = ['#3b82f6','#10b981','#f59e0b','#8b5cf6','#ef4444','#06b6d4','#ec4899','#14b8a6'];
  return colors[Math.abs(hash) % colors.length];
}

// ─── 初期化 ──────────────────────────────────────────────
(async () => {
  const token = getToken();
  if (token) {
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const user = await res.json();
      showApp(user);
    } else {
      clearToken();
    }
  }
})();
