// ─── 定数・ユーティリティ ─────────────────────────────────

const CAT_LABELS = { work: '仕事', household: '家事', leisure: '遊び', research: '研究', other: 'その他' };
const PRI_LABELS = { high: '高', medium: '中', low: '低' };
const STA_LABELS = { pending: '未着手', 'in-progress': '進行中', completed: '完了' };
const CAT_COLORS = { work: '#3b82f6', household: '#10b981', leisure: '#f59e0b', research: '#8b5cf6', other: '#6b7280' };

const $ = id => document.getElementById(id);
const today = () => new Date().toISOString().split('T')[0];

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  return res.json();
}

// ─── ナビゲーション ─────────────────────────────────────

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
  });
});

// ─── カレンダー ─────────────────────────────────────────

let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth(); // 0-indexed
let selectedDate = null;

function renderCalendar() {
  const title = $('calendar-title');
  title.textContent = `${calYear}年${calMonth + 1}月`;

  const grid = $('calendar-grid');
  grid.innerHTML = '';

  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  dayNames.forEach((d, i) => {
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

    for (let i = 0; i < firstDay; i++) {
      const cell = makeCell(calYear, calMonth - 1 < 0 ? 11 : calMonth - 1,
        daysInPrev - firstDay + i + 1, true, taskMap, todayStr, selectedDate);
      grid.appendChild(cell);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = makeCell(calYear, calMonth, d, false, taskMap, todayStr, selectedDate);
      grid.appendChild(cell);
    }
    let after = 1;
    while ((firstDay + daysInMonth + after - 1) % 7 !== 0) {
      const cell = makeCell(calYear, calMonth + 1 > 11 ? 0 : calMonth + 1, after, true, taskMap, todayStr, selectedDate);
      grid.appendChild(cell);
      after++;
    }
  });
}

function makeCell(year, month, day, otherMonth, taskMap, todayStr, selDate) {
  const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const dow = new Date(year, month, day).getDay();
  const cell = document.createElement('div');
  cell.className = 'cal-cell' +
    (otherMonth ? ' other-month' : '') +
    (dateStr === todayStr ? ' today' : '') +
    (dateStr === selDate ? ' selected' : '') +
    (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '');

  const dateEl = document.createElement('div');
  dateEl.className = 'cal-date';
  dateEl.textContent = day;
  cell.appendChild(dateEl);

  const tasks = taskMap[dateStr] || [];
  tasks.slice(0, 3).forEach(t => {
    const dot = document.createElement('span');
    dot.className = 'cal-dot';
    dot.style.background = CAT_COLORS[t.category] || '#999';
    dot.title = t.title;
    cell.appendChild(dot);
  });
  if (tasks.length > 3) {
    const more = document.createElement('span');
    more.style.cssText = 'font-size:0.65rem;color:#64748b;';
    more.textContent = `+${tasks.length - 3}`;
    cell.appendChild(more);
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
    if (tasks.length === 0) {
      list.innerHTML = '<p style="color:#64748b;font-size:.88rem;">タスクなし</p>';
      return;
    }
    tasks.forEach(t => list.appendChild(makeTaskCard(t, true)));
  });
}

$('prev-month').addEventListener('click', () => {
  calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; }
  selectedDate = null; $('day-tasks-panel').classList.add('hidden');
  renderCalendar();
});
$('next-month').addEventListener('click', () => {
  calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; }
  selectedDate = null; $('day-tasks-panel').classList.add('hidden');
  renderCalendar();
});

// ─── タスク一覧 ─────────────────────────────────────────

async function loadTasks() {
  const cat = $('filter-category').value;
  const sta = $('filter-status').value;
  let qs = [];
  if (cat) qs.push(`category=${cat}`);
  if (sta) qs.push(`status=${sta}`);
  const tasks = await api('GET', '/tasks' + (qs.length ? '?' + qs.join('&') : ''));
  const list = $('task-list');
  list.innerHTML = '';
  if (tasks.length === 0) {
    list.innerHTML = '<p style="color:#64748b;text-align:center;padding:30px;">タスクがありません</p>';
    return;
  }
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
    const newStatus = task.status === 'completed' ? 'pending' : 'completed';
    await api('PUT', `/tasks/${task.id}`, { status: newStatus });
    if (currentView === 'tasks') loadTasks();
    else if (selectedDate) showDayTasks(selectedDate);
    renderCalendar();
  });

  const body = document.createElement('div');
  body.className = 'task-body';
  body.innerHTML = `<div class="task-title">${escHtml(task.title)}</div>`;
  if (task.description && !compact) {
    body.innerHTML += `<div class="task-desc">${escHtml(task.description)}</div>`;
  }

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

  card.appendChild(check);
  card.appendChild(body);
  card.appendChild(actions);
  return card;
}

// ─── 進捗 ─────────────────────────────────────────────

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
  const catEntries = [
    ['work', '仕事'], ['household', '家事'], ['leisure', '遊び'], ['research', '研究'], ['other', 'その他']
  ];
  catEntries.forEach(([cat, label]) => {
    const d = data[cat];
    const p = d.total === 0 ? 0 : Math.round((d.done / d.total) * 100);
    const card = document.createElement('div');
    card.className = `progress-card cat-${cat}`;
    card.innerHTML = `
      <h3>${label}</h3>
      <div class="progress-nums">${d.done} / ${d.total} 件完了</div>
      <div class="progress-bar-wrap">
        <div class="progress-bar" style="width:${p}%;background:${CAT_COLORS[cat]}"></div>
      </div>
      <div style="font-size:.8rem;color:#64748b;margin-top:4px;">${p}%</div>
    `;
    charts.appendChild(card);
  });
}

// ─── モーダル ──────────────────────────────────────────

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
  $('f-title').focus();
}

$('close-modal').addEventListener('click', () => $('modal-overlay').classList.add('hidden'));
$('modal-overlay').addEventListener('click', e => {
  if (e.target === $('modal-overlay')) $('modal-overlay').classList.add('hidden');
});

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
  if (id) {
    await api('PUT', `/tasks/${id}`, body);
  } else {
    await api('POST', '/tasks', body);
  }
  $('modal-overlay').classList.add('hidden');
  if (currentView === 'tasks') loadTasks();
  else if (selectedDate) showDayTasks(selectedDate);
  renderCalendar();
});

// ─── プッシュ通知 ──────────────────────────────────────

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
    if (sub) {
      await sub.unsubscribe();
      await api('POST', '/unsubscribe', { endpoint: sub.endpoint });
    }
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

  const notifyTime = $('notify-time').value;
  await api('POST', '/subscribe', { subscription: sub.toJSON(), notifyTime });
  updateNotifyBtn(true);
  alert(`通知を有効化しました。毎朝 ${notifyTime} に今日の予定をお知らせします。`);
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ─── ユーティリティ ────────────────────────────────────

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── 初期化 ───────────────────────────────────────────

renderCalendar();
initNotifications();
