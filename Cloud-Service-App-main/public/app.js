/**
 * app.js - Logika sisi browser TaskHub (JavaScript murni, tanpa framework).
 *
 * Pola kerja: state (data di memori) -> refresh() mengambil data dari API -> fungsi render*()
 * menggambar ulang bagian halaman yang relevan.
 *
 * Isi file:
 *   1. Utilitas & state      6. Pengingat (notifikasi)       11. Dialog ubah + lampiran
 *   2. Login / daftar        7. Lampiran (tampilan)          12. Filter & pergantian tampilan
 *   3. Memuat data           8. Daftar, papan, aktivitas     13. Status database (health)
 *   4. Sidebar               9. Aksi tugas                   14. Start
 *   5. Dashboard            10. Form tambah tugas
 */
'use strict';

/* =====================================================================
 * 1. UTILITAS & STATE
 * ===================================================================== */
const $ = (selector) => document.querySelector(selector); // singkatan untuk mengambil elemen

// State aplikasi: satu-satunya sumber kebenaran untuk apa yang sedang ditampilkan.
const state = {
  user: null,
  config: { maxUploadMb: 5, maxAttachments: 5, reminderDays: 3 }, // diisi dari /api/auth/me
  view: 'dashboard',               // dashboard | list | board | activity
  projects: [], categories: [], todos: [],
  notifications: { count: 0, items: [] },
  filter: { project: 'all', category: 'all', status: 'all', priority: 'all', due: 'all', q: '', sort: 'default' },
  editing: null,                   // tugas yang sedang dibuka di dialog ubah
};

const PRIO = { low: 'Rendah', medium: 'Sedang', high: 'Tinggi' };
const STATUS_LABEL = { todo: 'To Do', in_progress: 'Sedang dikerjakan', done: 'Selesai' };
const NEXT_STATUS = { todo: 'in_progress', in_progress: 'done', done: 'todo' }; // urutan saat badge status diklik
const COLS = ['todo', 'in_progress', 'done'];                                   // urutan kolom Kanban
const ACTION_LABEL = {
  created: 'Dibuat', updated: 'Diubah', status_changed: 'Status berubah', deleted: 'Dihapus',
  attachment_added: 'Lampiran ditambah', attachment_removed: 'Lampiran dihapus',
};

/**
 * Pembuat elemen DOM: h('div', {class: 'x', onclick: fn}, 'teks', elemenLain)
 * Teks anak SELALU dimasukkan sebagai text node (bukan innerHTML), jadi isi dari pengguna
 * (judul tugas, nama file, dll.) tidak bisa menyisipkan HTML/script. Ini pertahanan utama terhadap XSS.
 */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); // onclick -> addEventListener('click')
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

/** Mengubah jumlah byte menjadi teks yang mudah dibaca (mis. 1536 -> "1.5 KB"). */
function formatSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Pembungkus fetch untuk memanggil API. Mengembalikan data JSON, atau melempar Error berisi
 * pesan dari server (field "error"). Bila sesi habis (401) pengguna dikembalikan ke halaman login.
 */
async function api(path, opts = {}) {
  let res;
  try { res = await fetch(path, { credentials: 'same-origin', ...opts }); }
  catch (_) { throw new Error('Tidak dapat menghubungi server.'); }
  let data = null;
  try { data = await res.json(); } catch (_) { /* respons tanpa body JSON */ }
  if (res.status === 401 && state.user) { showAuth(); throw new Error('Sesi berakhir, silakan masuk lagi.'); }
  if (!res.ok) throw new Error((data && data.error) || `Permintaan gagal (${res.status}).`);
  return data;
}
const jsonOpts = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Toast: pesan singkat di bawah layar, hilang otomatis setelah 3,5 detik.
let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (isError ? ' error' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
function showError(el, msg) { el.textContent = msg; el.hidden = !msg; }

/* =====================================================================
 * 2. LOGIN / DAFTAR
 * ===================================================================== */
let mode = 'login'; // 'login' atau 'register' (dua tab pada form yang sama)

function setMode(m) {
  mode = m;
  $('#tabLogin').setAttribute('aria-selected', m === 'login');
  $('#tabRegister').setAttribute('aria-selected', m === 'register');
  $('#authSubmit').textContent = m === 'login' ? 'Masuk' : 'Buat akun';
  $('#password').setAttribute('autocomplete', m === 'login' ? 'current-password' : 'new-password');
  showError($('#authError'), '');
}
$('#tabLogin').onclick = () => setMode('login');
$('#tabRegister').onclick = () => setMode('register');

async function authenticate(username, password) {
  try {
    await api(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, jsonOpts('POST', { username, password }));
    await boot(); // cookie sesi sudah dipasang server; muat aplikasi
  } catch (err) { showError($('#authError'), err.message); }
}
$('#authForm').onsubmit = (e) => { e.preventDefault(); authenticate($('#username').value, $('#password').value); };
document.querySelectorAll('[data-demo]').forEach((b) => {
  b.onclick = () => { setMode('login'); authenticate(b.dataset.demo, 'demo12345'); }; // tombol akun contoh
});
$('#logoutBtn').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); showAuth(); };

function showAuth() {
  state.user = null;
  $('#app').hidden = true; $('#auth').hidden = false; $('#password').value = '';
}

/** Dipanggil saat halaman dibuka dan setelah login: cek sesi, lalu tampilkan aplikasi. */
async function boot() {
  try {
    const me = await api('/api/auth/me');
    state.user = me;
    state.config = { maxUploadMb: me.maxUploadMb, maxAttachments: me.maxAttachments, reminderDays: me.reminderDays };
  } catch (_) { showAuth(); return; } // belum login -> tampilkan form login
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#whoami').textContent = state.user.username;
  state.filter.project = 'all'; state.filter.category = 'all';
  setView(state.view);
}

/* =====================================================================
 * 3. MEMUAT DATA
 * ===================================================================== */

/**
 * Mengambil semua data yang dibutuhkan tampilan aktif (secara paralel), lalu menggambar ulang.
 * Dipanggil setiap kali ada perubahan data atau filter.
 */
async function refresh() {
  try {
    const f = state.filter;
    // Data yang selalu dibutuhkan: sidebar (proyek, kategori, angka) dan pengingat.
    const jobs = [api('/api/projects'), api('/api/categories'), api('/api/todos/stats'), api('/api/notifications')];
    // Data khusus tampilan yang sedang dibuka:
    if (state.view === 'dashboard') jobs.push(api('/api/dashboard'));
    else if (state.view === 'activity') jobs.push(api('/api/activity?limit=50'));
    else if (state.view === 'trash') jobs.push(api('/api/trash')); // <-- TAMBAHAN 1: panggil API trash
    else {
      const qs = new URLSearchParams({
        status: state.view === 'board' ? 'all' : f.status, // papan Kanban sudah memisahkan per status
        project: f.project, category: f.category, priority: f.priority, due: f.due, sort: f.sort,
      });
      if (f.q) qs.set('q', f.q);
      jobs.push(api('/api/todos?' + qs));
    }
    const [projects, categories, stats, notifications, extra] = await Promise.all(jobs);

    state.projects = projects; state.categories = categories; state.notifications = notifications;
    renderSidebar(stats); renderHeader(stats); fillSelects(); renderNotifications();

    if (state.view === 'dashboard') renderDashboard(extra);
    else if (state.view === 'activity') renderActivity(extra);
    else if (state.view === 'trash') renderTrash(extra); // <-- TAMBAHAN 2: render tampilan trash
    else { state.todos = extra; if (state.view === 'board') renderBoard(); else renderTodos(); }
  } catch (err) { toast(err.message, true); }
}

/* =====================================================================
 * 4. SIDEBAR: PROYEK & KATEGORI
 * ===================================================================== */

/** Satu baris di sidebar. kind = 'project' atau 'category' (sekaligus nama kunci filter). */
function navItem(kind, item) {
  const dot = h('span', { class: 'dot' });
  dot.style.setProperty('--c', item.color); // warna lewat CSS variable (aman dari aturan CSP)
  const right = kind === 'project' ? `${item.done}/${item.total}` : String(item.active); // proyek: progres; kategori: jumlah aktif
  const del = h('button', {
    class: 'del', type: 'button', title: `Hapus ${kind === 'project' ? 'proyek' : 'kategori'}`,
    'aria-label': `Hapus ${item.name}`, onclick: (e) => { e.stopPropagation(); deleteNamed(kind, item); },
  }, '×');
  const row = h('div', {
    class: 'nav-item', role: 'button', tabindex: '0',
    'aria-current': String(String(state.filter[kind]) === String(item.id)), // baris aktif = sedang dijadikan filter
  }, dot, h('span', { class: 'label' }, item.name), del, h('span', { class: 'count' }, right));
  row.onclick = () => selectFilter(kind, String(item.id));
  row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectFilter(kind, String(item.id)); } };

  if (kind !== 'project') return row;
  // Proyek punya bar progres kecil di bawah namanya.
  const mini = h('div', { class: 'mini' }, h('i'));
  mini.firstChild.style.setProperty('--w', (item.total ? (item.done / item.total) * 100 : 0) + '%');
  mini.firstChild.style.setProperty('--c', item.color);
  return h('div', { class: 'nav-block' }, row, mini);
}

function renderSidebar(stats) {
  $('#countAll').textContent = stats.todo + stats.in_progress; // jumlah tugas yang belum selesai
  $('#projList').replaceChildren(...state.projects.map((p) => navItem('project', p)));
  $('#catList').replaceChildren(...state.categories.map((c) => navItem('category', c)));
  const f = state.filter;
  $('#navAll').setAttribute('aria-current', String(f.project === 'all' && f.category === 'all'));
  document.querySelectorAll('[data-proj="none"]').forEach((b) => b.setAttribute('aria-current', String(f.project === 'none')));
  document.querySelectorAll('[data-cat="none"]').forEach((b) => b.setAttribute('aria-current', String(f.category === 'none')));
}

/** Mengganti filter proyek/kategori dari sidebar. Dari Dashboard/Aktivitas otomatis pindah ke Daftar. */
function selectFilter(kind, value) {
  state.filter[kind] = value;
  if (state.view === 'dashboard' || state.view === 'activity') setView('list'); else refresh();
}
$('#navAll').onclick = () => { state.filter.project = 'all'; state.filter.category = 'all'; if (state.view === 'dashboard' || state.view === 'activity') setView('list'); else refresh(); };
document.querySelectorAll('[data-proj="none"]').forEach((b) => { b.onclick = () => selectFilter('project', 'none'); });
document.querySelectorAll('[data-cat="none"]').forEach((b) => { b.onclick = () => selectFilter('category', 'none'); });

/** Judul halaman mengikuti tampilan dan filter aktif. */
function renderHeader(stats) {
  const f = state.filter;
  const name = (list, id) => (list.find((x) => String(x.id) === String(id)) || {}).name;
  let title = 'Semua tugas';
  if (state.view === 'dashboard') title = 'Dashboard';
  else if (state.view === 'activity') title = 'Aktivitas terbaru';
  else {
    const parts = [];
    if (f.project === 'none') parts.push('Tanpa proyek'); else if (f.project !== 'all') parts.push(name(state.projects, f.project));
    if (f.category === 'none') parts.push('Tanpa kategori'); else if (f.category !== 'all') parts.push(name(state.categories, f.category));
    if (parts.length) title = parts.filter(Boolean).join(' - ');
  }
  $('#viewTitle').textContent = title;

  // Ringkasan angka di pojok header (disembunyikan di Dashboard karena sudah ada kartu besar).
  const item = (label, val, cls = '') => h('div', { class: cls }, h('dt', {}, label), h('dd', {}, String(val)));
  $('#stats').replaceChildren(item('To Do', stats.todo), item('Dikerjakan', stats.in_progress), item('Selesai', stats.done), item('Terlambat', stats.overdue, stats.overdue ? 'late' : ''));
}

/** Mengisi dropdown proyek & kategori di form tambah dan dialog ubah, tanpa menghilangkan pilihan sebelumnya. */
function fillSelects() {
  const fill = (sel, list, emptyLabel, filterKey) => {
    const el = $(sel); const prev = el.value;
    el.replaceChildren(h('option', { value: '' }, emptyLabel), ...list.map((x) => h('option', { value: x.id }, x.name)));
    if ([...el.options].some((o) => o.value === prev)) el.value = prev;
    else if (sel.startsWith('#f') && /^\d+$/.test(state.filter[filterKey])) el.value = state.filter[filterKey]; // default = filter aktif
  };
  fill('#fProject', state.projects, 'Tanpa proyek', 'project');
  fill('#eProject', state.projects, 'Tanpa proyek', 'project');
  fill('#fCategory', state.categories, 'Tanpa kategori', 'category');
  fill('#eCategory', state.categories, 'Tanpa kategori', 'category');
}

// Form tambah proyek dan kategori di sidebar memakai fungsi yang sama.
function bindNamedForm(formSel, nameSel, colorSel, endpoint, okMsg) {
  $(formSel).onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(endpoint, jsonOpts('POST', { name: $(nameSel).value, color: $(colorSel).value }));
      $(nameSel).value = ''; toast(okMsg); await refresh();
    } catch (err) { toast(err.message, true); }
  };
}
bindNamedForm('#projForm', '#projName', '#projColor', '/api/projects', 'Proyek ditambahkan.');
bindNamedForm('#catForm', '#catName', '#catColor', '/api/categories', 'Kategori ditambahkan.');

async function deleteNamed(kind, item) {
  const label = kind === 'project' ? 'proyek' : 'kategori';
  if (!confirm(`Hapus ${label} "${item.name}"? Tugas di dalamnya tidak ikut terhapus, hanya menjadi tanpa ${label}.`)) return;
  try {
    await api(`/api/${kind === 'project' ? 'projects' : 'categories'}/${item.id}`, { method: 'DELETE' });
    if (state.filter[kind] === String(item.id)) state.filter[kind] = 'all';
    toast(`${label[0].toUpperCase() + label.slice(1)} dihapus.`); await refresh();
  } catch (err) { toast(err.message, true); }
}

/* =====================================================================
 * 5. DASHBOARD
 * ===================================================================== */
function renderDashboard(d) {
  const s = d.stats;
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;

  const stat = (label, n, cls = '') => h('div', { class: 'stat ' + cls }, h('b', {}, String(n)), h('span', {}, label));
  // Bar horizontal: lebar diatur lewat CSS variable --w (0-100%).
  const bar = (percent, color) => {
    const b = h('div', { class: 'bar' }, h('i'));
    b.firstChild.style.setProperty('--w', percent + '%');
    if (color) b.firstChild.style.setProperty('--c', color);
    return b;
  };
  const dotOf = (color) => { const x = h('span', { class: 'dot' }); x.style.setProperty('--c', color); return x; };

  // Panel "Belum selesai per prioritas"
  const prioMax = Math.max(1, ...d.by_priority.map((x) => x.n));
  const prioRows = ['high', 'medium', 'low'].map((p) => {
    const n = (d.by_priority.find((x) => x.priority === p) || { n: 0 }).n;
    const color = p === 'high' ? 'var(--danger)' : p === 'medium' ? 'var(--warn)' : 'var(--muted)';
    return h('div', { class: 'brow' }, h('span', { class: 'name' }, PRIO[p]), bar((n / prioMax) * 100, color), h('span', { class: 'num' }, String(n)));
  });

  // Panel "Progres per proyek" dan "Penyelesaian per kategori"
  const progressRows = (list, emptyText) => list.length ? list.map((x) =>
    h('div', { class: 'brow' }, h('span', { class: 'name' }, dotOf(x.color), x.name),
      bar(x.total ? (x.done / x.total) * 100 : 0, x.color), h('span', { class: 'num' }, `${x.done}/${x.total}`))) : [h('p', { class: 'desc' }, emptyText)];

  // Panel "Tenggat terdekat"
  const fmt = (x) => new Date(x + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  const upcoming = d.upcoming.length ? d.upcoming.map((t) => h('li', {},
    h('span', {}, t.title), h('span', { class: 'when ' + (t.overdue ? 'late' : '') }, (t.overdue ? 'Terlambat ' : '') + fmt(t.due_date))))
    : [h('li', { class: 'desc' }, 'Tidak ada tenggat yang menunggu.')];

  $('#dashboard').replaceChildren(
    // Baris 1: kartu angka ringkasan
    h('div', { class: 'cards' },
      stat('Total tugas', s.total), stat('To Do', s.todo), stat('Sedang dikerjakan', s.in_progress), stat('Selesai', s.done),
      stat('Hari ini', s.due_today), stat('Terlambat', s.overdue, s.overdue ? 'warn' : ''), stat('Punya lampiran', s.with_attachments)),
    // Baris 2: progres keseluruhan
    h('div', { class: 'panel' },
      h('div', { class: 'progress-row' }, h('strong', {}, 'Progres keseluruhan'), h('span', {}, `${pct}% (${s.done} dari ${s.total} selesai)`)),
      bar(pct, 'var(--ok)')),
    // Baris 3: pengingat (diisi renderNotifications) + panel rincian
    h('div', { class: 'panel' }, h('h3', {}, 'Pengingat'), h('div', { id: 'dashNotif' })),
    h('div', { class: 'panels' },
      h('div', { class: 'panel' }, h('h3', {}, 'Progres per proyek'), progressRows(d.by_project, 'Belum ada proyek.')),
      h('div', { class: 'panel' }, h('h3', {}, 'Penyelesaian per kategori'), progressRows(d.by_category, 'Belum ada tugas.')),
      h('div', { class: 'panel' }, h('h3', {}, 'Belum selesai per prioritas'), prioRows),
      h('div', { class: 'panel' }, h('h3', {}, 'Tenggat terdekat'), h('ul', { class: 'due-list' }, upcoming))));
  renderNotifications(); // isi panel pengingat yang baru dibuat
}

/* =====================================================================
 * 6. PENGINGAT (notifikasi di dalam website)
 *    Data dihitung server dari tenggat tugas (GET /api/notifications).
 * ===================================================================== */
const NOTIF_GROUPS = [
  ['overdue', 'Terlambat'], ['today', 'Tenggat hari ini'], ['soon', 'Segera berakhir'], ['new', 'Baru ditambahkan'],
];

function notifText(n) {
  if (n.type === 'overdue') return `Terlambat ${Math.abs(n.days_left)} hari`;
  if (n.type === 'today') return 'Tenggat hari ini';
  if (n.type === 'soon') return n.days_left === 1 ? 'Tenggat besok' : `Tenggat ${n.days_left} hari lagi`;
  return 'Ditambahkan dalam 24 jam terakhir';
}

/** Membuat daftar pengingat yang dikelompokkan per jenis. Dipakai di dropdown dan di Dashboard. */
function notifNodes() {
  const items = state.notifications.items;
  if (!items.length) return [h('p', { class: 'desc' }, 'Tidak ada pengingat. Semua tenggat aman.')];
  return NOTIF_GROUPS.flatMap(([type, label]) => {
    const group = items.filter((n) => n.type === type);
    if (!group.length) return [];
    return [
      h('p', { class: 'notif-group t-' + type }, `${label} (${group.length})`),
      ...group.map((n) => h('button', { type: 'button', class: 'notif-item', onclick: () => openTask(n.title) },
        h('strong', {}, n.title), h('span', {}, notifText(n)))),
    ];
  });
}

/** Memperbarui lencana angka di tombol, isi dropdown, dan panel di Dashboard (bila sedang tampil). */
function renderNotifications() {
  const count = state.notifications.count;
  $('#bellCount').textContent = String(count);
  $('#bellCount').hidden = count === 0;
  $('#notifList').replaceChildren(...notifNodes());
  const dash = $('#dashNotif');
  if (dash) dash.replaceChildren(...notifNodes());
}

/** Klik pengingat: buka Daftar dengan pencarian judul tugas itu. */
function openTask(title) {
  Object.assign(state.filter, { project: 'all', category: 'all', status: 'all', priority: 'all', due: 'all', q: title });
  $('#search').value = title; $('#priorityFilter').value = 'all'; $('#dueFilter').value = 'all';
  document.querySelectorAll('#statusSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.status === 'all')));
  toggleNotifPanel(false);
  setView('list');
}

function toggleNotifPanel(open) {
  const panel = $('#notifPanel');
  const show = open === undefined ? panel.hidden : open;
  panel.hidden = !show;
  $('#bellBtn').setAttribute('aria-expanded', String(show));
}
$('#bellBtn').onclick = (e) => { e.stopPropagation(); toggleNotifPanel(); };
document.addEventListener('click', (e) => { if (!e.target.closest('.notif-wrap')) toggleNotifPanel(false); }); // klik di luar = tutup
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleNotifPanel(false); });

// Pengingat diperbarui otomatis tiap 60 detik (tanpa menggambar ulang seluruh halaman).
setInterval(async () => {
  if (!state.user) return;
  try { state.notifications = await api('/api/notifications'); renderNotifications(); } catch (_) { /* abaikan */ }
}, 60000);

/* =====================================================================
 * 7. LAMPIRAN (tampilan)
 * ===================================================================== */
const isImage = (a) => a.kind === 'file' && a.mime && a.mime.startsWith('image/');

/** Satu lampiran: gambar -> thumbnail; file -> tautan unduh; link -> tautan ke situs luar. */
function attachmentNode(a, t) {
  if (a.kind === 'link') {
    // noopener noreferrer: halaman tujuan tidak mendapat akses ke halaman TaskHub kita.
    return h('a', { class: 'chip link', href: a.url, target: '_blank', rel: 'noopener noreferrer', title: a.url }, a.name);
  }
  if (isImage(a)) {
    return h('img', { class: 'thumb', src: `/api/attachments/${a.id}`, alt: `Lampiran ${a.name} pada ${t.title}`, loading: 'lazy', onclick: () => openViewer(a) });
  }
  return h('a', { class: 'chip', href: `/api/attachments/${a.id}`, download: a.name }, `${a.name} (${formatSize(a.size)})`);
}
const attachmentRow = (t) => (t.attachments.length ? h('div', { class: 'attach' }, t.attachments.map((a) => attachmentNode(a, t))) : null);

function openViewer(a) {
  $('#viewerImg').src = `/api/attachments/${a.id}`; $('#viewerImg').alt = a.name;
  $('#viewer').showModal(); // <dialog> bawaan browser: otomatis fokus & tutup dengan Esc
}
$('#viewerClose').onclick = () => $('#viewer').close();
$('#viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') $('#viewer').close(); });

/* =====================================================================
 * 8. DAFTAR, PAPAN KANBAN, AKTIVITAS
 * ===================================================================== */

/** Teks tenggat; merah bila terlambat (flag "overdue" dihitung database). */
function dueLabel(t) {
  if (!t.due_date) return null;
  const txt = new Date(t.due_date + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  return t.overdue ? h('span', { class: 'late' }, 'Terlambat: ' + txt) : h('span', {}, 'Tenggat ' + txt);
}

/** Baris informasi di bawah judul: badge status, proyek, kategori, prioritas, tenggat. */
function metaRow(t) {
  const tag = (name, color) => { const d = h('span', { class: 'dot' }); d.style.setProperty('--c', color); return h('span', { class: 'pill' }, d, name); };
  return h('div', { class: 'meta' },
    // Klik badge = ganti ke status berikutnya (To Do -> In Progress -> Done -> To Do)
    h('button', { class: 'badge s-' + t.status, type: 'button', title: 'Klik untuk mengganti status', onclick: () => setStatus(t, NEXT_STATUS[t.status]) }, STATUS_LABEL[t.status]),
    t.project_name ? tag(t.project_name, t.project_color) : null,
    t.category_name ? tag(t.category_name, t.category_color) : null,
    h('span', { class: 'prio-' + t.priority }, 'Prioritas ' + PRIO[t.priority].toLowerCase()),
    dueLabel(t));
}

function renderTodos() {
  const list = $('#todoList');
  if (!state.todos.length) {
    const f = state.filter;
    const filtered = f.q || f.status !== 'all' || f.project !== 'all' || f.category !== 'all' || f.priority !== 'all' || f.due !== 'all';
    list.replaceChildren(h('li', { class: 'empty' }, filtered ? 'Tidak ada tugas yang cocok dengan filter ini.' : 'Belum ada tugas. Tulis tugas pertamamu di kolom di atas.'));
    return;
  }
  list.replaceChildren(...state.todos.map((t) => {
    const done = t.status === 'done';
    const li = h('li', { class: 'todo' + (done ? ' done' : '') },
      h('button', { class: 'check-btn', type: 'button', 'aria-label': done ? 'Tandai belum selesai' : 'Tandai selesai', onclick: () => setStatus(t, done ? 'todo' : 'done') }, done ? '✓' : ''),
      h('div', {},
        h('div', { class: 'title' }, t.title),
        t.description ? h('div', { class: 'desc' }, t.description) : null,
        metaRow(t), attachmentRow(t)),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => openEdit(t) }, 'Ubah'),
        h('button', { type: 'button', class: 'danger', onclick: () => removeTodo(t) }, 'Hapus')));
    if (t.project_color || t.category_color) li.style.setProperty('--c', t.project_color || t.category_color); // garis warna di tepi kiri
    return li;
  }));
}

/** Kartu pada papan Kanban. Bisa diseret (drag) atau dipindah dengan tombol panah (cocok untuk HP/keyboard). */
function boardCard(t) {
  const i = COLS.indexOf(t.status);
  const move = (to, arrow) => h('button', {
    type: 'button', 'aria-label': 'Pindah ke ' + STATUS_LABEL[to], title: 'Pindah ke ' + STATUS_LABEL[to], onclick: () => setStatus(t, to),
  }, arrow);
  const card = h('li', { class: 'card', draggable: 'true', ondragstart: (e) => e.dataTransfer.setData('text/plain', String(t.id)) },
    h('div', { class: 'title' }, t.title), metaRow(t),
    t.attachments.length ? h('div', { class: 'meta' }, h('span', {}, `${t.attachments.length} lampiran`)) : null,
    h('div', { class: 'actions' }, i > 0 ? move(COLS[i - 1], '←') : null, i < 2 ? move(COLS[i + 1], '→') : null,
      h('button', { type: 'button', onclick: () => openEdit(t) }, 'Ubah')));
  if (t.project_color || t.category_color) card.style.setProperty('--c', t.project_color || t.category_color);
  return card;
}

function renderBoard() {
  for (const status of COLS) {
    const items = state.todos.filter((t) => t.status === status);
    $('#n-' + status).textContent = items.length;
    $('#col-' + status).replaceChildren(...(items.length ? items.map(boardCard) : [h('li', { class: 'col-empty' }, 'Kosong. Seret tugas ke sini.')]));
  }
}

// Seret-dan-lepas: kolom menerima kartu lalu memanggil API untuk mengubah status.
document.querySelectorAll('.col').forEach((col) => {
  col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); }); // preventDefault = izinkan drop
  col.addEventListener('dragleave', () => col.classList.remove('over'));
  col.addEventListener('drop', (e) => {
    e.preventDefault(); col.classList.remove('over');
    const t = state.todos.find((x) => x.id === Number(e.dataTransfer.getData('text/plain')));
    if (t) setStatus(t, col.dataset.status);
  });
});

function renderActivity(rows) {
  $('#activityList').replaceChildren(...(rows.length
    ? rows.map((r) => h('li', {},
      h('time', { datetime: r.created_at }, new Date(r.created_at).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })),
      h('div', {}, h('span', { class: 'act' }, ACTION_LABEL[r.action] || r.action), r.detail)))
    : [h('li', { class: 'empty' }, 'Belum ada aktivitas.')]));
}

/* =====================================================================
 * 9. AKSI TUGAS
 * ===================================================================== */
async function setStatus(t, status) {
  if (t.status === status) return;
  try { await api(`/api/todos/${t.id}/status`, jsonOpts('PATCH', { status })); toast('Status: ' + STATUS_LABEL[status] + '.'); await refresh(); }
  catch (err) { toast(err.message, true); }
}

async function removeTodo(t) {
  if (!confirm(`Hapus tugas "${t.title}"? Lampirannya ikut terhapus.`)) return;
  try { await api('/api/todos/' + t.id, { method: 'DELETE' }); toast('Tugas dihapus.'); await refresh(); }
  catch (err) { toast(err.message, true); }
}

/* =====================================================================
 * 10. FORM TAMBAH TUGAS
 * ===================================================================== */

/**
 * Validasi awal file di browser (supaya pengguna langsung tahu tanpa menunggu server).
 * Server tetap memeriksa ulang; validasi di browser hanya untuk kenyamanan, bukan keamanan.
 */
function checkFiles(input, errEl, alreadyAttached = 0) {
  const files = [...input.files];
  const { maxUploadMb, maxAttachments } = state.config;
  if (files.length + alreadyAttached > maxAttachments) { showError(errEl, `Maksimal ${maxAttachments} lampiran per tugas.`); input.value = ''; return false; }
  const tooBig = files.find((f) => f.size > maxUploadMb * 1024 * 1024);
  if (tooBig) { showError(errEl, `"${tooBig.name}" melebihi ${maxUploadMb} MB.`); input.value = ''; return false; }
  return true;
}

$('#fFiles').onchange = () => {
  showError($('#formError'), '');
  const ok = checkFiles($('#fFiles'), $('#formError'));
  const n = ok ? $('#fFiles').files.length : 0;
  $('#fFilesLabel').textContent = n ? `${n} file dipilih` : 'Lampirkan foto atau file';
};

$('#todoForm').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#formError'); showError(err, '');
  if (!$('#fTitle').value.trim()) { showError(err, 'Judul tugas tidak boleh kosong.'); $('#fTitle').focus(); return; }
  try {
    // FormData = multipart/form-data, satu-satunya cara mengirim file bersama field teks.
    await api('/api/todos', { method: 'POST', body: new FormData($('#todoForm')) });
    ['#fTitle', '#fDesc', '#fDue', '#fFiles', '#fLink'].forEach((s) => { $(s).value = ''; });
    $('#fFilesLabel').textContent = 'Lampirkan foto atau file';
    toast('Tugas ditambahkan.'); await refresh();
  } catch (ex) { showError(err, ex.message); }
};

/* =====================================================================
 * 11. DIALOG UBAH TUGAS + KELOLA LAMPIRAN
 * ===================================================================== */
function openEdit(t) {
  state.editing = t; showError($('#editError'), '');
  $('#eTitle').value = t.title; $('#eDesc').value = t.description; $('#ePriority').value = t.priority;
  $('#eDue').value = t.due_date || ''; $('#eStatus').value = t.status;
  $('#eProject').value = t.project_id || ''; $('#eCategory').value = t.category_id || '';
  $('#eFiles').value = ''; $('#eLink').value = ''; $('#eLinkTitle').value = ''; $('#eFilesLabel').textContent = 'Pilih file';
  renderEditAttachments();
  loadSubtasks(t.id);
  $('#editDialog').showModal();
}

/** Daftar lampiran di dalam dialog, masing-masing dengan tombol hapus. */
function renderEditAttachments() {
  const t = state.editing;
  $('#eAttachList').replaceChildren(...(t.attachments.length
    ? t.attachments.map((a) => h('li', {},
      a.kind === 'link' ? h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.name)
        : h('a', { href: `/api/attachments/${a.id}`, download: a.name }, a.name),
      h('span', { class: 'desc' }, a.kind === 'link' ? 'link' : formatSize(a.size)),
      h('button', { type: 'button', class: 'link-danger', onclick: () => deleteAttachment(a) }, 'Hapus')))
    : [h('li', { class: 'desc' }, 'Belum ada lampiran.')]));
}

/** Setelah lampiran berubah: muat ulang data, lalu perbarui daftar lampiran di dialog. */
async function afterAttachmentChange(message) {
  toast(message);
  await refresh();
  state.editing = state.todos.find((x) => x.id === state.editing.id) || state.editing;
  renderEditAttachments();
}

async function deleteAttachment(a) {
  try { await api('/api/attachments/' + a.id, { method: 'DELETE' }); await afterAttachmentChange('Lampiran dihapus.'); }
  catch (err) { showError($('#editError'), err.message); }
}

$('#eFiles').onchange = () => {
  showError($('#editError'), '');
  const ok = checkFiles($('#eFiles'), $('#editError'), state.editing.attachments.length);
  const n = ok ? $('#eFiles').files.length : 0;
  $('#eFilesLabel').textContent = n ? `${n} file dipilih` : 'Pilih file';
};

$('#eFilesBtn').onclick = async () => {
  showError($('#editError'), '');
  if (!$('#eFiles').files.length) { showError($('#editError'), 'Pilih file terlebih dahulu.'); return; }
  const fd = new FormData();
  [...$('#eFiles').files].forEach((f) => fd.append('files', f));
  try {
    await api(`/api/todos/${state.editing.id}/files`, { method: 'POST', body: fd });
    $('#eFiles').value = ''; $('#eFilesLabel').textContent = 'Pilih file';
    await afterAttachmentChange('File diunggah.');
  } catch (err) { showError($('#editError'), err.message); }
};

$('#eLinkBtn').onclick = async () => {
  showError($('#editError'), '');
  if (!$('#eLink').value.trim()) { showError($('#editError'), 'Isi alamat link terlebih dahulu.'); return; }
  try {
    await api(`/api/todos/${state.editing.id}/links`, jsonOpts('POST', { url: $('#eLink').value, title: $('#eLinkTitle').value }));
    $('#eLink').value = ''; $('#eLinkTitle').value = '';
    await afterAttachmentChange('Link ditambahkan.');
  } catch (err) { showError($('#editError'), err.message); }
};

$('#editCancel').onclick = () => $('#editDialog').close();
$('#editForm').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#editError'); showError(err, '');
  if (!$('#eTitle').value.trim()) { showError(err, 'Judul tugas tidak boleh kosong.'); return; }
  try {
    await api('/api/todos/' + state.editing.id, jsonOpts('PUT', {
      title: $('#eTitle').value, description: $('#eDesc').value, priority: $('#ePriority').value, due_date: $('#eDue').value,
      status: $('#eStatus').value, project_id: $('#eProject').value, category_id: $('#eCategory').value,
    }));
    $('#editDialog').close(); toast('Perubahan disimpan.'); await refresh();
  } catch (ex) { showError(err, ex.message); }
};
/* =====================================================================
 * FITUR TAMBAHAN: Logika Sub-tugas di Dialog Ubah
 * ===================================================================== */
async function loadSubtasks(todoId) {
  try {
    const subtasks = await api(`/api/todos/${todoId}/subtasks`);
    $('#eSubtaskList').replaceChildren(...(subtasks.length ? subtasks.map(renderSubtask) : [h('li', { class: 'desc' }, 'Belum ada sub-tugas.')]));
  } catch (err) { toast('Gagal memuat sub-tugas', true); }
}

function renderSubtask(s) {
  const checkbox = h('input', { type: 'checkbox', checked: s.is_done, onchange: async (e) => {
    try {
      await api(`/api/subtasks/${s.id}/status`, jsonOpts('PATCH', { is_done: e.target.checked }));
      span.style.textDecoration = e.target.checked ? 'line-through' : 'none';
      span.style.color = e.target.checked ? 'var(--muted)' : 'var(--ink)';
    } catch (err) { e.target.checked = !e.target.checked; toast(err.message, true); }
  }});
  
  const span = h('span', { style: `flex: 1; text-decoration: ${s.is_done ? 'line-through' : 'none'}; color: ${s.is_done ? 'var(--muted)' : 'var(--ink)'};` }, s.title);
  
  return h('li', { style: 'display: flex; gap: 10px; align-items: center; width: 100%; margin-bottom: 6px;' },
    checkbox, span,
    h('button', { type: 'button', class: 'link-danger', onclick: async () => {
      if(!confirm('Hapus sub-tugas?')) return;
      try {
        await api(`/api/subtasks/${s.id}`, { method: 'DELETE' });
        loadSubtasks(state.editing.id);
      } catch (err) { toast(err.message, true); }
    }}, 'Hapus')
  );
}

$('#eSubtaskBtn').onclick = async () => {
  const input = $('#eSubtaskTitle');
  if (!input.value.trim()) return;
  try {
    await api(`/api/todos/${state.editing.id}/subtasks`, jsonOpts('POST', { title: input.value }));
    input.value = '';
    loadSubtasks(state.editing.id);
  } catch (err) { showError($('#editError'), err.message); }
};

/* =====================================================================
 * 12. FILTER & PERGANTIAN TAMPILAN
 * ===================================================================== */
let searchTimer;
// Pencarian "debounce": menunggu pengguna berhenti mengetik 250 ms sebelum memanggil API.
$('#search').oninput = (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.filter.q = e.target.value.trim(); refresh(); }, 250); };
$('#sort').onchange = (e) => { state.filter.sort = e.target.value; refresh(); };
$('#priorityFilter').onchange = (e) => { state.filter.priority = e.target.value; refresh(); };
$('#dueFilter').onchange = (e) => { state.filter.due = e.target.value; refresh(); };
document.querySelectorAll('#statusSeg button').forEach((b) => {
  b.onclick = () => {
    state.filter.status = b.dataset.status;
    document.querySelectorAll('#statusSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    refresh();
  };
});

/** Berpindah antara Dashboard / Daftar / Papan / Aktivitas: tampilkan bagian yang sesuai, sembunyikan lainnya. */
function setView(v) {
  state.view = v;
  document.querySelectorAll('#viewSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  $('#workArea').hidden = v === 'dashboard' || v === 'activity'; // form tambah + filter hanya untuk Daftar dan Papan
  $('#stats').hidden = v === 'dashboard';
  $('#statusSeg').hidden = v === 'board';
  $('#dashboard').hidden = v !== 'dashboard';
  $('#todoList').hidden = v !== 'list';
  $('#board').hidden = v !== 'board';
  $('#activity').hidden = v !== 'activity';
  $('#workArea').hidden = v === 'dashboard' || v === 'activity' || v === 'trash';
  $('#statusSeg').hidden = v === 'board' || v === 'trash';
  $('#trashList').hidden = v !== 'trash';
  
}
document.querySelectorAll('#viewSeg button').forEach((b) => { 
  b.onclick = () => {
    setView(b.dataset.view);
    refresh();
   };
  });

/* =====================================================================
 * 13. STATUS DATABASE - indikator di sidebar, memanggil /health tiap 10 detik
 * ===================================================================== */
async function checkHealth() {
  const box = $('#dbStatus'), txt = $('#dbStatusText');
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    box.className = 'status ' + (res.ok ? 'up' : 'down');
    txt.textContent = res.ok ? 'Database terhubung' : 'Database terputus';
  } catch (_) { box.className = 'status down'; txt.textContent = 'Server tidak merespons'; }
}

/* =====================================================================
 * 14. START
 * ===================================================================== */
checkHealth();
setInterval(checkHealth, 10000);
boot();

/* =====================================================================
 * FITUR TAMBAHAN: RECYCLE BIN (TONG SAMPAH)
 * ===================================================================== */
function renderTrash(items) {
  const list = $('#trashList');
  if (!items.length) {
    list.replaceChildren(h('li', { class: 'empty' }, 'Tong sampah kosong.'));
    return;
  }
  list.replaceChildren(...items.map((t) => {
    return h('li', { class: 'todo' },
      h('div', {}, ''),
      h('div', {},
        h('div', { class: 'title' }, t.title),
        t.description ? h('div', { class: 'desc' }, t.description) : null,
        metaRow(t)),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: async () => {
          try {
            await api(`/api/trash/${t.id}/restore`, { method: 'POST' });
            toast('Tugas dipulihkan.'); await refresh();
          } catch (err) { toast(err.message, true); }
        }}, 'Pulihkan'),
        h('button', { type: 'button', class: 'danger', onclick: async () => {
          if (!confirm(`Hapus permanen "${t.title}"? Data tidak dapat dikembalikan.`)) return;
          try {
            await api(`/api/trash/${t.id}/permanent`, { method: 'DELETE' });
            toast('Tugas dihapus permanen.'); await refresh();
          } catch (err) { toast(err.message, true); }
        }}, 'Hapus Permanen'))
    );
  }));
}