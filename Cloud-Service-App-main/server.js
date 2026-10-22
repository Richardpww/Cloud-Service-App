/**
 * server.js - Backend TaskHub (Node.js + Express).
 *
 * Alur umum sebuah request:
 *   browser -> middleware (header keamanan, log) -> auth (cek login) -> validasi input
 *           -> query database lewat db.withUser() (dibatasi RLS) -> respons JSON.
 *
 * Isi file (berurutan):
 *   1. Konfigurasi        5. Validasi input        9. Proyek & kategori
 *   2. Middleware         6. Health check         10. Tugas, dashboard, pengingat
 *   3. Helper umum        7. Autentikasi          11. Lampiran
 *   4. Penanganan file    8. Log aktivitas        12. Error handler & start server
 */
require('dotenv').config(); // baca file .env bila dijalankan tanpa Docker
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('./db');
const log = require('./logger');

/* =====================================================================
 * 1. KONFIGURASI (semua dari environment variable, lihat .env.example)
 * ===================================================================== */
const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads')); // di-mount sebagai volume Docker
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 5;       // ukuran maksimal per file
const MAX_ATTACHMENTS = Number(process.env.MAX_ATTACHMENTS) || 5;   // jumlah lampiran maksimal per tugas
const REMINDER_DAYS = Number(process.env.REMINDER_DAYS) || 3;       // tenggat <= N hari lagi dianggap "segera"
const COOKIE_NAME = 'taskhub_token';
const PRIORITIES = ['low', 'medium', 'high'];
const STATUSES = ['todo', 'in_progress', 'done'];
const STATUS_LABEL = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };

// Kunci penandatangan token login. Bila kosong, buat acak (konsekuensi: semua sesi hilang saat restart).
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  log.warn('JWT_SECRET kosong: memakai secret acak (semua sesi login hilang saat restart).');
}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* =====================================================================
 * 2. MIDDLEWARE (dijalankan untuk setiap request, berurutan)
 * ===================================================================== */
const app = express();
app.disable('x-powered-by');              // jangan umumkan bahwa server memakai Express
app.use(express.json({ limit: '100kb' })); // baca body JSON (batas 100 KB)

// Header keamanan + pencatatan log request.
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff', // browser dilarang menebak tipe file (mencegah file diperlakukan sebagai script)
    'X-Frame-Options': 'DENY',           // halaman tidak boleh dimasukkan ke <iframe> situs lain
    // CSP: hanya boleh memuat script/style dari server sendiri. Ini lapisan pertahanan terhadap XSS.
    'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'",
  });
  const start = Date.now();
  res.on('finish', () => {
    // Healthcheck Docker datang tiap 15 detik; yang sukses tidak perlu memenuhi log.
    if (req.path === '/health' && res.statusCode === 200) return;
    log.info(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

/* =====================================================================
 * 3. HELPER UMUM
 * ===================================================================== */

/** Error yang membawa kode status HTTP. Ditangkap oleh error handler di bagian akhir file. */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg); // 400 = permintaan salah (input tidak valid)

/** Membungkus handler async agar error-nya diteruskan ke error handler (Express 4 tidak melakukannya otomatis). */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Mengubah nilai menjadi ID integer positif, atau melempar 400. Mencegah input aneh masuk ke query. */
function toId(v, msg = 'ID tidak valid.') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw bad(msg);
  return n;
}

/** ID opsional: kosong / "null" berarti tidak ada (NULL di database). */
function optionalId(v, msg) {
  return v === undefined || v === null || v === '' || v === 'null' ? null : toId(v, msg);
}

/** Memecah header Cookie menjadi objek {nama: nilai}. */
function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/* =====================================================================
 * 4. PENANGANAN FILE UPLOAD
 * ===================================================================== */

// File ditampung di memori dulu (maks MAX_UPLOAD_MB) agar isinya bisa diperiksa sebelum disimpan ke disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_ATTACHMENTS, fields: 15 },
});
const uploadFiles = upload.array('files', MAX_ATTACHMENTS); // field form bernama "files", boleh banyak

const OFFICE_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

/**
 * Mengenali jenis file dari ISI-nya (magic bytes), bukan dari ekstensi atau Content-Type kiriman
 * browser, karena keduanya mudah dipalsukan. Mengembalikan null bila jenisnya tidak diizinkan.
 * Jenis yang diizinkan: gambar (JPG/PNG/WEBP/GIF), PDF, dokumen Office/ZIP, dan teks (txt/csv/md).
 */
function detectFile(buf, originalName) {
  if (!buf.length) return null; // file kosong
  const ext = path.extname(originalName).slice(1).toLowerCase();
  const ascii = (a, b) => buf.toString('ascii', a, b);

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (ascii(0, 3) === 'GIF') return { ext: 'gif', mime: 'image/gif' };
  if (ascii(0, 5) === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  // docx/xlsx/pptx/zip sebenarnya arsip ZIP (diawali "PK\3\4"); ekstensi menentukan jenis dokumennya.
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 3 && buf[3] === 4 && OFFICE_MIME[ext]) return { ext, mime: OFFICE_MIME[ext] };
  // File teks: tidak boleh mengandung byte NUL (ciri file biner).
  if (['txt', 'csv', 'md'].includes(ext) && !buf.subarray(0, 8192).includes(0)) {
    return { ext, mime: ext === 'csv' ? 'text/csv' : ext === 'md' ? 'text/markdown' : 'text/plain' };
  }
  return null;
}

/** Nama file dari browser dikirim dalam encoding latin1; ubah ke UTF-8 dan bersihkan karakter berbahaya. */
function cleanFileName(name = 'file') {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.replace(/[\\/\x00-\x1f]/g, '_').trim().slice(0, 150) || 'file';
}

/** Menghapus file fisik dari volume uploads (diam bila file sudah tidak ada). */
const removeFile = (stored) => (stored ? fs.promises.unlink(path.join(UPLOAD_DIR, stored)).catch(() => {}) : null);

/**
 * Memeriksa dan menyimpan file-file hasil upload ke disk dengan nama acak (UUID).
 * Nama acak mencegah tabrakan nama dan penebakan URL. Bila salah satu file ditolak,
 * file lain yang sudah tersimpan dihapus lagi (semua-atau-tidak-sama-sekali).
 */
async function saveFiles(files = []) {
  const saved = [];
  try {
    for (const f of files) {
      const name = cleanFileName(f.originalname);
      const type = detectFile(f.buffer, name);
      if (!type) throw bad(`File "${name}" ditolak. Yang diizinkan: gambar, PDF, docx/xlsx/pptx, zip, txt/csv/md.`);
      const stored = `${crypto.randomUUID()}.${type.ext}`;
      await fs.promises.writeFile(path.join(UPLOAD_DIR, stored), f.buffer);
      saved.push({ kind: 'file', name, stored_name: stored, mime: type.mime, size: f.buffer.length });
    }
    return saved;
  } catch (err) {
    await Promise.all(saved.map((s) => removeFile(s.stored_name)));
    throw err;
  }
}

/** Memvalidasi link lampiran. Hanya http/https; skema berbahaya seperti javascript: ditolak. */
function parseLink(url, title) {
  let u;
  try { u = new URL(String(url).trim()); } catch (_) { throw bad('Link tidak valid.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw bad('Link harus diawali http:// atau https://.');
  if (u.href.length > 500) throw bad('Link maksimal 500 karakter.');
  return { kind: 'link', name: String(title || '').trim().slice(0, 150) || u.hostname, url: u.href };
}

/* =====================================================================
 * 5. VALIDASI INPUT (lapis kedua; lapis pertama di browser, lapis ketiga constraint database)
 * ===================================================================== */

/** Memvalidasi dan membersihkan data tugas dari body request. Melempar 400 dengan pesan jelas. */
function parseTodoInput(b) {
  const title = String(b.title ?? '').trim();
  if (!title) throw bad('Judul tugas tidak boleh kosong.');
  if (title.length > 120) throw bad('Judul tugas maksimal 120 karakter.');

  const description = String(b.description ?? '').trim();
  if (description.length > 1000) throw bad('Deskripsi maksimal 1000 karakter.');

  const priority = String(b.priority || 'medium');
  if (!PRIORITIES.includes(priority)) throw bad('Prioritas harus low, medium, atau high.');

  const due_date = b.due_date ? String(b.due_date) : null;
  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) throw bad('Format tanggal harus YYYY-MM-DD.');

  const status = b.status ? String(b.status) : null; // null = pakai default/status lama
  if (status && !STATUSES.includes(status)) throw bad('Status harus todo, in_progress, atau done.');

  return {
    title, description, priority, due_date, status,
    category_id: optionalId(b.category_id, 'Kategori tidak valid.'),
    project_id: optionalId(b.project_id, 'Proyek tidak valid.'),
  };
}

/* =====================================================================
 * 6. HEALTH CHECK - dipakai Docker (HEALTHCHECK) dan indikator di sidebar
 * ===================================================================== */
app.get('/health', async (req, res) => {
  try {
    await db.pool.query('SELECT 1'); // uji nyata: apakah database bisa dihubungi?
    res.json({ status: 'UP', database: 'CONNECTED', uptime_seconds: Math.round(process.uptime()), time: new Date().toISOString() });
  } catch (err) {
    log.error(`Health check gagal: ${err.message}`);
    res.status(503).json({ status: 'DOWN', database: 'DISCONNECTED', error: err.message }); // 503 = layanan tidak tersedia
  }
});

/* =====================================================================
 * 7. AUTENTIKASI - JWT disimpan di cookie httpOnly
 * ===================================================================== */

/** Membuat token login (berlaku 8 jam) dan menaruhnya di cookie. httpOnly = tidak bisa dibaca JavaScript. */
function startSession(res, user) {
  const token = jwt.sign({ username: user.username }, JWT_SECRET, { subject: String(user.id), expiresIn: '8h' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax', // cookie tidak dikirim pada request lintas-situs (mitigasi CSRF)
    secure: process.env.COOKIE_SECURE === 'true', // true bila sudah memakai HTTPS
    maxAge: 8 * 60 * 60 * 1000,
  });
}

/** Middleware: wajib login. Token dibaca dari cookie atau header "Authorization: Bearer ..." (untuk curl). */
function auth(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = bearer || parseCookies(req.headers.cookie)[COOKIE_NAME];
  try {
    const payload = jwt.verify(token, JWT_SECRET); // melempar error bila token palsu/kedaluwarsa
    req.user = { id: Number(payload.sub), username: payload.username };
    next();
  } catch (_) {
    next(new HttpError(401, 'Silakan login terlebih dahulu.')); // 401 = belum login
  }
}

// Pengguna baru otomatis mendapat satu proyek dan tiga kategori agar aplikasi langsung bisa dipakai.
const DEFAULT_PROJECT = ['Tugas Kuliah', '#1d4ed8'];
const DEFAULT_CATEGORIES = [['Kuliah', '#0f766e'], ['Pribadi', '#c2410c'], ['Organisasi', '#6d28d9']];

app.post('/api/auth/register', wrap(async (req, res) => {
  const username = String(req.body.username ?? '').trim().toLowerCase();
  const password = String(req.body.password ?? '');
  if (!/^[a-z0-9_]{3,30}$/.test(username)) throw bad('Username 3-30 karakter: huruf, angka, atau underscore.');
  if (password.length < 8 || password.length > 72) throw bad('Password harus 8-72 karakter.'); // bcrypt hanya membaca 72 byte pertama

  let user;
  try {
    const hash = await bcrypt.hash(password, 10); // password TIDAK pernah disimpan, hanya hash-nya
    ({ rows: [user] } = await db.pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username', [username, hash]));
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'Username sudah dipakai.'); // 23505 = pelanggaran UNIQUE
    throw err;
  }
  await db.withUser(user.id, async (c) => {
    await c.query('INSERT INTO projects (user_id, name, color) VALUES ($1, $2, $3)', [user.id, ...DEFAULT_PROJECT]);
    for (const [name, color] of DEFAULT_CATEGORIES) {
      await c.query('INSERT INTO categories (user_id, name, color) VALUES ($1, $2, $3)', [user.id, name, color]);
    }
  });
  startSession(res, user);
  log.info(`User baru terdaftar: ${user.username}`);
  res.status(201).json({ id: user.id, username: user.username });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const username = String(req.body.username ?? '').trim().toLowerCase();
  const password = String(req.body.password ?? '');
  const { rows } = await db.pool.query('SELECT id, username, password_hash FROM users WHERE username = $1', [username]);
  const ok = rows.length > 0 && (await bcrypt.compare(password, rows[0].password_hash));
  if (!ok) {
    // Pesan sengaja sama untuk "username tidak ada" dan "password salah" agar akun tidak bisa ditebak.
    log.warn(`Login gagal untuk username "${username.slice(0, 30)}"`);
    throw new HttpError(401, 'Username atau password salah.');
  }
  startSession(res, rows[0]);
  log.info(`Login berhasil: ${rows[0].username}`);
  res.json({ id: rows[0].id, username: rows[0].username });
}));

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ message: 'Berhasil keluar.' });
});

// Info pengguna aktif + batas-batas yang dipakai frontend untuk validasi awal di browser.
app.get('/api/auth/me', auth, (req, res) => {
  res.json({ ...req.user, maxUploadMb: MAX_UPLOAD_MB, maxAttachments: MAX_ATTACHMENTS, reminderDays: REMINDER_DAYS });
});

/* =====================================================================
 * 8. LOG AKTIVITAS - dicatat di tabel activity_log dan di log container
 * ===================================================================== */
async function logActivity(c, user, action, todoId, detail) {
  await c.query('INSERT INTO activity_log (user_id, todo_id, action, detail) VALUES ($1, $2, $3, $4)',
    [user.id, todoId, action, String(detail).slice(0, 200)]);
  log.info(`[AKTIVITAS] ${user.username} ${action}: ${detail}`);
}

app.get('/api/activity', auth, wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const rows = await db.withUser(req.user.id, async (c) => (await c.query(
    'SELECT id, action, detail, todo_id, created_at FROM activity_log ORDER BY id DESC LIMIT $1', [limit])).rows);
  res.json(rows);
}));

/* =====================================================================
 * 9. PROYEK & KATEGORI
 *    Keduanya punya bentuk yang sama (nama + warna), jadi rute tambah/ubah/hapus
 *    dibuat sekali lewat fungsi pabrik di bawah ini.
 * ===================================================================== */
function mountNamedCrud({ route, table, label, maxName, defaultColor }) {
  // Nama tabel di bawah selalu berasal dari kode kita sendiri (bukan input pengguna), jadi aman dipakai di SQL.
  const parse = (b) => {
    const name = String(b.name ?? '').trim();
    if (!name) throw bad(`Nama ${label} tidak boleh kosong.`);
    if (name.length > maxName) throw bad(`Nama ${label} maksimal ${maxName} karakter.`);
    const color = b.color ? String(b.color) : defaultColor;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw bad('Warna harus berformat #RRGGBB.');
    return { name, color };
  };
  const duplicate = (err) => { if (err.code === '23505') throw new HttpError(409, `${label} dengan nama itu sudah ada.`); throw err; };

  app.post(route, auth, wrap(async (req, res) => {
    const { name, color } = parse(req.body);
    const row = await db.withUser(req.user.id, async (c) => (await c.query(
      `INSERT INTO ${table} (user_id, name, color) VALUES ($1, $2, $3) RETURNING id, name, color`,
      [req.user.id, name, color])).rows[0]).catch(duplicate);
    res.status(201).json(row);
  }));

  app.put(`${route}/:id`, auth, wrap(async (req, res) => {
    const id = toId(req.params.id);
    const { name, color } = parse(req.body);
    const row = await db.withUser(req.user.id, async (c) => (await c.query(
      `UPDATE ${table} SET name = $1, color = $2 WHERE id = $3 RETURNING id, name, color`, [name, color, id])).rows[0]).catch(duplicate);
    if (!row) throw new HttpError(404, `${label} tidak ditemukan.`); // 404 juga muncul bila id milik pengguna lain (RLS)
    res.json(row);
  }));

  app.delete(`${route}/:id`, auth, wrap(async (req, res) => {
    const id = toId(req.params.id);
    const n = await db.withUser(req.user.id, async (c) => (await c.query(`DELETE FROM ${table} WHERE id = $1`, [id])).rowCount);
    if (!n) throw new HttpError(404, `${label} tidak ditemukan.`);
    res.json({ message: `${label} dihapus. Tugas di dalamnya menjadi tanpa ${label.toLowerCase()}.` });
  }));
}
mountNamedCrud({ route: '/api/projects', table: 'projects', label: 'Proyek', maxName: 60, defaultColor: '#1d4ed8' });
mountNamedCrud({ route: '/api/categories', table: 'categories', label: 'Kategori', maxName: 40, defaultColor: '#0f766e' });

// Daftar proyek beserta progresnya (jumlah tugas total/selesai/dikerjakan/terlambat), dihitung di SQL.
app.get('/api/projects', auth, wrap(async (req, res) => {
  const rows = await db.withUser(req.user.id, async (c) => (await c.query(
    `SELECT p.id, p.name, p.color,
            COUNT(t.id)::int AS total,
            COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS done,
            COUNT(t.id) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
            COUNT(t.id) FILTER (WHERE t.status <> 'done' AND t.due_date < CURRENT_DATE)::int AS overdue
     FROM projects p LEFT JOIN todos t ON t.project_id = p.id AND (t.is_deleted = false OR t.is_deleted IS NULL)
     GROUP BY p.id ORDER BY p.name`)).rows);
  res.json(rows);
}));

app.get('/api/categories', auth, wrap(async (req, res) => {
  const rows = await db.withUser(req.user.id, async (c) => (await c.query(
    `SELECT c.id, c.name, c.color,
            COUNT(t.id)::int AS total,
            COUNT(t.id) FILTER (WHERE t.status <> 'done')::int AS active
     FROM categories c LEFT JOIN todos t ON t.category_id = c.id AND (t.is_deleted = false OR t.is_deleted IS NULL)
     GROUP BY c.id ORDER BY c.name`)).rows);
  res.json(rows);
}));

/* =====================================================================
 * 10. TUGAS, DASHBOARD, PENGINGAT
 * ===================================================================== */

// SELECT dasar untuk satu atau banyak tugas. Lampiran digabung menjadi array JSON per tugas.
// Karena dijalankan lewat withUser(), subquery lampiran pun otomatis dibatasi RLS.
const TODO_SELECT = `
  SELECT t.id, t.title, t.description, t.priority, t.due_date::text AS due_date, t.status,
         (t.status <> 'done' AND t.due_date < CURRENT_DATE) AS overdue,
         t.category_id, c.name AS category_name, c.color AS category_color,
         t.project_id, p.name AS project_name, p.color AS project_color,
         COALESCE((SELECT json_agg(json_build_object('id', a.id, 'kind', a.kind, 'name', a.name,
                                                      'url', a.url, 'mime', a.mime_type, 'size', a.size_bytes) ORDER BY a.id)
                   FROM attachments a WHERE a.todo_id = t.id), '[]'::json) AS attachments,
         EXTRACT(EPOCH FROM t.updated_at)::bigint AS version
  FROM todos t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN projects p ON p.id = t.project_id`;

// Pilihan pengurutan (kunci dari query ?sort=). Tugas "done" selalu di bawah.
const ORDERS = {
  default: "(t.status = 'done'), CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.due_date NULLS LAST, t.id",
  due: "(t.status = 'done'), t.due_date NULLS LAST, t.id",
  newest: "(t.status = 'done'), t.created_at DESC",
};

// Statistik ringkas; dipakai oleh /api/todos/stats (sidebar) dan /api/dashboard.
const STATS_SQL = `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'todo')::int AS todo,
            COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
            COUNT(*) FILTER (WHERE status = 'done')::int AS done,
            COUNT(*) FILTER (WHERE status <> 'done' AND due_date < CURRENT_DATE)::int AS overdue,
            COUNT(*) FILTER (WHERE status <> 'done' AND due_date = CURRENT_DATE)::int AS due_today,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM attachments a WHERE a.todo_id = todos.id))::int AS with_attachments
     FROM todos WHERE is_deleted = false OR is_deleted IS NULL`;

app.get('/api/todos/stats', auth, wrap(async (req, res) => {
  res.json(await db.withUser(req.user.id, async (c) => (await c.query(STATS_SQL)).rows[0]));
}));

// Dashboard: semua angka dihitung dengan agregasi SQL di database, bukan di browser.
app.get('/api/dashboard', auth, wrap(async (req, res) => {
  const data = await db.withUser(req.user.id, async (c) => ({
    stats: (await c.query(STATS_SQL)).rows[0],
    // tugas yang belum selesai, dikelompokkan per prioritas
    by_priority: (await c.query("SELECT priority, COUNT(*)::int AS n FROM todos WHERE status <> 'done' AND (is_deleted = false OR is_deleted IS NULL) GROUP BY priority")).rows,
    // progres per kategori (termasuk tugas tanpa kategori)
    by_category: (await c.query(
      `SELECT COALESCE(c.name, 'Tanpa kategori') AS name, COALESCE(c.color, '#94a3b8') AS color,
              COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t.status = 'done')::int AS done
       FROM todos t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.is_deleted = false OR t.is_deleted IS NULL
       GROUP BY c.id, c.name, c.color ORDER BY total DESC, name`)).rows,
    // progres per proyek, mis. "Cloud Services: 5 dari 8 selesai"
    by_project: (await c.query(
      `SELECT p.id, p.name, p.color, COUNT(t.id)::int AS total, COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS done
       FROM projects p LEFT JOIN todos t ON t.project_id = p.id AND (t.is_deleted = false OR t.is_deleted IS NULL) GROUP BY p.id ORDER BY p.name`)).rows,
    // 5 tenggat terdekat dari tugas yang belum selesai
    upcoming: (await c.query(
      `SELECT id, title, priority, due_date::text AS due_date, (due_date < CURRENT_DATE) AS overdue
       FROM todos WHERE status <> 'done' AND due_date IS NOT NULL AND (is_deleted = false OR is_deleted IS NULL) ORDER BY due_date, id LIMIT 5`)).rows,
  }));
  res.json(data);
}));

/**
 * Pengingat (notifikasi di dalam website). Dihitung langsung dari data tugas, jadi otomatis
 * hilang begitu tugasnya selesai. Jenisnya, dari yang paling mendesak:
 *   overdue = lewat tenggat | today = tenggat hari ini | soon = tenggat <= REMINDER_DAYS hari
 *   new     = tugas yang baru ditambahkan dalam 24 jam terakhir
 */
app.get('/api/notifications', auth, wrap(async (req, res) => {
  const items = await db.withUser(req.user.id, async (c) => (await c.query(
    `SELECT * FROM (
       SELECT t.id AS todo_id, t.title, t.due_date::text AS due_date, (t.due_date - CURRENT_DATE) AS days_left,
              CASE WHEN t.due_date < CURRENT_DATE THEN 'overdue'
                   WHEN t.due_date = CURRENT_DATE THEN 'today'
                   WHEN t.due_date <= CURRENT_DATE + $1::int THEN 'soon'
                   ELSE 'new' END AS type
       FROM todos t
       WHERE t.status <> 'done' AND (t.is_deleted = false OR t.is_deleted IS NULL)
         AND ((t.due_date IS NOT NULL AND t.due_date <= CURRENT_DATE + $1::int)
              OR t.created_at >= now() - interval '24 hours')
     ) n
     ORDER BY array_position(ARRAY['overdue', 'today', 'soon', 'new'], type), due_date NULLS LAST, todo_id`,
    [REMINDER_DAYS])).rows);
  res.json({ count: items.length, items });
}));

// Daftar tugas dengan filter: ?status= &project= &category= &priority= &due= &q= &sort=
app.get('/api/todos', auth, wrap(async (req, res) => {
  const { status, project, category, priority, due, q, sort } = req.query;
  const where = ['(t.is_deleted = false OR t.is_deleted IS NULL)']; // menyembunyikan tugas terhapus
  const params = [];  // nilai untuk $1, $2, ... (parameter terpisah dari SQL = aman dari SQL injection)

  if (status && status !== 'all') {
    if (!STATUSES.includes(status)) throw bad('Status harus all, todo, in_progress, atau done.');
    params.push(status); where.push(`t.status = $${params.length}`);
  }
  if (priority && priority !== 'all') {
    if (!PRIORITIES.includes(priority)) throw bad('Prioritas harus all, low, medium, atau high.');
    params.push(priority); where.push(`t.priority = $${params.length}`);
  }
  if (due && due !== 'all') {
    const DUE = {
      overdue: "(t.status <> 'done' AND t.due_date < CURRENT_DATE)",
      today: 't.due_date = CURRENT_DATE',
      week: 't.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7',
      none: 't.due_date IS NULL',
    };
    if (!DUE[due]) throw bad('Filter tenggat harus all, overdue, today, week, atau none.');
    where.push(DUE[due]);
  }
  if (project === 'none') where.push('t.project_id IS NULL');
  else if (project && project !== 'all') { params.push(toId(project, 'Proyek tidak valid.')); where.push(`t.project_id = $${params.length}`); }
  if (category === 'none') where.push('t.category_id IS NULL');
  else if (category && category !== 'all') { params.push(toId(category, 'Kategori tidak valid.')); where.push(`t.category_id = $${params.length}`); }
  if (q) {
    // Karakter khusus LIKE (\ % _) di-escape agar dianggap teks biasa.
    params.push(`%${String(q).slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length})`);
  }
  const order = ORDERS[sort] || ORDERS.default; // dipilih dari daftar tetap, bukan dari input mentah
  const sql = `${TODO_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`;
  res.json(await db.withUser(req.user.id, async (c) => (await c.query(sql, params)).rows));
}));

/** Menyimpan baris lampiran ke database dan mencatatnya di log. items = hasil saveFiles()/parseLink(). */
async function insertAttachments(c, user, todoId, todoTitle, items) {
  const rows = [];
  for (const it of items) {
    const r = await c.query(
      `INSERT INTO attachments (user_id, todo_id, kind, name, url, stored_name, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, kind, name`,
      [user.id, todoId, it.kind, it.name, it.url || null, it.stored_name || null, it.mime || null, it.size || null]);
    rows.push(r.rows[0]);
    await logActivity(c, user, 'attachment_added', todoId, `"${todoTitle}": ${it.name}`);
  }
  return rows;
}

/** Memastikan jumlah lampiran satu tugas tidak melebihi MAX_ATTACHMENTS. */
async function assertCapacity(c, todoId, adding) {
  const { rows } = await c.query('SELECT COUNT(*)::int AS n FROM attachments WHERE todo_id = $1', [todoId]);
  if (rows[0].n + adding > MAX_ATTACHMENTS) throw bad(`Maksimal ${MAX_ATTACHMENTS} lampiran per tugas.`);
}

// Tambah tugas. Dikirim sebagai multipart/form-data karena boleh membawa file (field "files") dan link (field "link_url").
app.post('/api/todos', auth, uploadFiles, wrap(async (req, res) => {
  const t = parseTodoInput(req.body);
  const link = req.body.link_url ? parseLink(req.body.link_url) : null;
  const fileCount = (req.files || []).length;
  if (fileCount + (link ? 1 : 0) > MAX_ATTACHMENTS) throw bad(`Maksimal ${MAX_ATTACHMENTS} lampiran per tugas.`);

  const saved = await saveFiles(req.files); // simpan file ke disk SEBELUM transaksi database
  try {
    const row = await db.withUser(req.user.id, async (c) => {
      const ins = await c.query(
        `INSERT INTO todos (user_id, project_id, category_id, title, description, priority, due_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [req.user.id, t.project_id, t.category_id, t.title, t.description, t.priority, t.due_date, t.status || 'todo']);
      const id = ins.rows[0].id;
      await logActivity(c, req.user, 'created', id, `"${t.title}"`);
      await insertAttachments(c, req.user, id, t.title, link ? [...saved, link] : saved);
      return (await c.query(`${TODO_SELECT} WHERE t.id = $1`, [id])).rows[0];
    });
    res.status(201).json(row);
  } catch (err) {
    await Promise.all(saved.map((s) => removeFile(s.stored_name))); // database gagal -> bersihkan file yatim
    throw err;
  }
}));

// Ubah tugas (JSON). Lampiran dikelola lewat endpoint terpisah di bagian 11.
app.put('/api/todos/:id', auth, wrap(async (req, res) => {
  const id = toId(req.params.id);
  const t = parseTodoInput(req.body);
  const row = await db.withUser(req.user.id, async (c) => {
    const cur = await c.query('SELECT status FROM todos WHERE id = $1 FOR UPDATE', [id]); // kunci baris selama transaksi
    if (!cur.rows.length) throw new HttpError(404, 'Tugas tidak ditemukan.');
    const oldStatus = cur.rows[0].status;
    const status = t.status || oldStatus;
    await c.query(
      `UPDATE todos SET project_id = $1, category_id = $2, title = $3, description = $4, priority = $5,
              due_date = $6, status = $7, updated_at = now() WHERE id = $8`,
      [t.project_id, t.category_id, t.title, t.description, t.priority, t.due_date, status, id]);
    await logActivity(c, req.user, 'updated', id, `"${t.title}"`);
    if (status !== oldStatus) {
      await logActivity(c, req.user, 'status_changed', id, `"${t.title}": ${STATUS_LABEL[oldStatus]} -> ${STATUS_LABEL[status]}`);
    }
    return (await c.query(`${TODO_SELECT} WHERE t.id = $1`, [id])).rows[0];
  });
  res.json(row);
}));

// Pindah status (dipakai papan Kanban, badge status, dan tombol centang).
app.patch('/api/todos/:id/status', auth, wrap(async (req, res) => {
  const id = toId(req.params.id);
  const status = String(req.body.status ?? '');
  if (!STATUSES.includes(status)) throw bad('Status harus todo, in_progress, atau done.');
  const row = await db.withUser(req.user.id, async (c) => {
    const cur = await c.query('SELECT title, status FROM todos WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows.length) throw new HttpError(404, 'Tugas tidak ditemukan.');
    if (cur.rows[0].status !== status) { // hanya catat bila benar-benar berubah
      await c.query('UPDATE todos SET status = $1, updated_at = now() WHERE id = $2', [status, id]);
      await logActivity(c, req.user, 'status_changed', id,
        `"${cur.rows[0].title}": ${STATUS_LABEL[cur.rows[0].status]} -> ${STATUS_LABEL[status]}`);
    }
    return (await c.query(`${TODO_SELECT} WHERE t.id = $1`, [id])).rows[0];
  });
  res.json(row);
}));

/* =====================================================================
 * FITUR RECYCLE BIN (SOFT DELETE & TRASH)
 * ===================================================================== */

// Hapus tugas sementara (masuk Tong Sampah)
app.delete('/api/todos/:id', auth, wrap(async (req, res) => {
  const id = toId(req.params.id);
  const r = await db.withUser(req.user.id, async (c) => {
    const res = await c.query('UPDATE todos SET is_deleted = true WHERE id = $1 AND (is_deleted = false OR is_deleted IS NULL) RETURNING title', [id]);
    if (!res.rows[0]) return null;
    await logActivity(c, req.user, 'deleted', id, `"${res.rows[0].title}" (Masuk Tong Sampah)`);
    return res.rows[0];
  });
  if (!r) throw new HttpError(404, 'Tugas tidak ditemukan.');
  res.json({ message: 'Tugas dipindahkan ke Tong Sampah.' });
}));

// Ambil daftar tugas di Tong Sampah
app.get('/api/trash', auth, wrap(async (req, res) => {
  const sql = `${TODO_SELECT} WHERE t.is_deleted = true ORDER BY t.updated_at DESC`;
  res.json(await db.withUser(req.user.id, async (c) => (await c.query(sql)).rows));
}));

// Pulihkan tugas dari Tong Sampah
app.post('/api/trash/:id/restore', auth, wrap(async (req, res) => {
  const id = toId(req.params.id);
  const r = await db.withUser(req.user.id, async (c) => {
    const res = await c.query('UPDATE todos SET is_deleted = false WHERE id = $1 RETURNING title', [id]);
    if (!res.rows[0]) return null;
    await logActivity(c, req.user, 'updated', id, `"${res.rows[0].title}" (Dipulihkan)`);
    return res.rows[0];
  });
  if (!r) throw new HttpError(404, 'Tugas tidak ditemukan.');
  res.json({ message: 'Tugas berhasil dipulihkan.' });
}));

// Hapus PERMANEN tugas dan file lampirannya
app.delete('/api/trash/:id/permanent', auth, wrap(async (req, res) => {
  const id = toId(req.params.id);
  const del = await db.withUser(req.user.id, async (c) => {
    const files = await c.query("SELECT stored_name FROM attachments WHERE todo_id = $1 AND kind = 'file'", [id]);
    const r = await c.query('DELETE FROM todos WHERE id = $1 RETURNING title', [id]);
    if (!r.rows[0]) return null;
    await logActivity(c, req.user, 'deleted', id, `"${r.rows[0].title}" (Hapus permanen)`);
    return files.rows.map((f) => f.stored_name);
  });
  if (!del) throw new HttpError(404, 'Tugas tidak ditemukan.');
  await Promise.all(del.map(removeFile));
  res.json({ message: 'Tugas dihapus permanen.' });
}));

/* =====================================================================
 * 11. LAMPIRAN (file dan link)
 * ===================================================================== */

// Tambah file ke tugas yang sudah ada (boleh banyak sekaligus).
app.post('/api/todos/:id/files', auth, uploadFiles, wrap(async (req, res) => {
  const id = toId(req.params.id);
  if (!req.files || !req.files.length) throw bad('Pilih minimal satu file.');
  const saved = await saveFiles(req.files);
  try {
    const rows = await db.withUser(req.user.id, async (c) => {
      const todo = await c.query('SELECT title FROM todos WHERE id = $1 FOR UPDATE', [id]);
      if (!todo.rows.length) throw new HttpError(404, 'Tugas tidak ditemukan.');
      await assertCapacity(c, id, saved.length);
      return insertAttachments(c, req.user, id, todo.rows[0].title, saved);
    });
    res.status(201).json(rows);
  } catch (err) {
    await Promise.all(saved.map((s) => removeFile(s.stored_name)));
    throw err;
  }
}));

// Tambah link ke tugas yang sudah ada.
app.post('/api/todos/:id/links', auth, wrap(async (req, res) => {
  const id = toId(req.params.id);
  const link = parseLink(req.body.url, req.body.title);
  const rows = await db.withUser(req.user.id, async (c) => {
    const todo = await c.query('SELECT title FROM todos WHERE id = $1 FOR UPDATE', [id]);
    if (!todo.rows.length) throw new HttpError(404, 'Tugas tidak ditemukan.');
    await assertCapacity(c, id, 1);
    return insertAttachments(c, req.user, id, todo.rows[0].title, [link]);
  });
  res.status(201).json(rows);
}));

// Mengambil/mengunduh file. Kepemilikan dicek lewat RLS: lampiran milik pengguna lain tampil sebagai 404.
app.get('/api/attachments/:id', auth, wrap(async (req, res) => {
  const id = toId(req.params.id);
  const row = await db.withUser(req.user.id, async (c) => (await c.query(
    "SELECT name, stored_name, mime_type FROM attachments WHERE id = $1 AND kind = 'file'", [id])).rows[0]);
  if (!row) throw new HttpError(404, 'Lampiran tidak ditemukan.');
  const file = path.join(UPLOAD_DIR, row.stored_name);
  // Gambar ditampilkan langsung di halaman; jenis lain SELALU diunduh (Content-Disposition: attachment)
  // agar tidak pernah dieksekusi/dirender browser.
  if (row.mime_type.startsWith('image/')) res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=3600' } });
  else res.download(file, row.name);
}));

// Hapus satu lampiran.
app.delete('/api/attachments/:id', auth, wrap(async (req, res) => {
  const id = toId(req.params.id);
  const del = await db.withUser(req.user.id, async (c) => {
    const r = await c.query('DELETE FROM attachments WHERE id = $1 RETURNING todo_id, name, stored_name', [id]);
    if (!r.rows[0]) return null;
    const todo = await c.query('SELECT title FROM todos WHERE id = $1', [r.rows[0].todo_id]);
    await logActivity(c, req.user, 'attachment_removed', r.rows[0].todo_id, `"${todo.rows[0] ? todo.rows[0].title : ''}": ${r.rows[0].name}`);
    return r.rows[0];
  });
  if (!del) throw new HttpError(404, 'Lampiran tidak ditemukan.');
  await removeFile(del.stored_name);
  res.json({ message: 'Lampiran dihapus.' });
}));

/* =====================================================================
 * 11.5 FITUR TAMBAHAN: SUB-TUGAS
 * ===================================================================== */
// Mengambil daftar sub-tugas dari suatu tugas
app.get('/api/todos/:id/subtasks', auth, wrap(async (req, res) => {
  const todoId = toId(req.params.id);
  const rows = await db.withUser(req.user.id, async (c) => {
    return (await c.query('SELECT id, title, is_done FROM subtasks WHERE todo_id = $1 ORDER BY id', [todoId])).rows;
  });
  res.json(rows);
}));

// Tambah sub-tugas baru
app.post('/api/todos/:id/subtasks', auth, wrap(async (req, res) => {
  const todoId = toId(req.params.id);
  const title = String(req.body.title ?? '').trim();
  if (!title) throw bad('Judul sub-tugas tidak boleh kosong.');
  
  const row = await db.withUser(req.user.id, async (c) => {
    // Pastikan tugas milik user
    const todo = await c.query('SELECT title FROM todos WHERE id = $1', [todoId]);
    if (!todo.rows.length) throw new HttpError(404, 'Tugas tidak ditemukan.');
    
    return (await c.query(
      'INSERT INTO subtasks (user_id, todo_id, title) VALUES ($1, $2, $3) RETURNING id, title, is_done',
      [req.user.id, todoId, title]
    )).rows[0];
  });
  res.status(201).json(row);
}));

// Ubah status sub-tugas (centang/un-centang)
app.patch('/api/subtasks/:id/status', auth, wrap(async (req, res) => {
  const id = toId(req.params.id);
  const isDone = Boolean(req.body.is_done);
  
  const row = await db.withUser(req.user.id, async (c) => {
    return (await c.query(
      'UPDATE subtasks SET is_done = $1 WHERE id = $2 RETURNING id, title, is_done',
      [isDone, id]
    )).rows[0];
  });
  if (!row) throw new HttpError(404, 'Sub-tugas tidak ditemukan.');
  res.json(row);
}));

// Hapus sub-tugas
app.delete('/api/subtasks/:id', auth, wrap(async (req, res) => {
  const id = toId(req.params.id);
  const n = await db.withUser(req.user.id, async (c) => (await c.query('DELETE FROM subtasks WHERE id = $1', [id])).rowCount);
  if (!n) throw new HttpError(404, 'Sub-tugas tidak ditemukan.');
  res.json({ message: 'Sub-tugas dihapus.' });
}));

/* =====================================================================
 * 12. FRONTEND STATIS, ERROR HANDLER, DAN START SERVER
 * ===================================================================== */
app.use(express.static(path.join(__dirname, 'public'))); // index.html, style.css, app.js
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));

// Kode error yang menandakan database tidak bisa dihubungi.
const DB_DOWN_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '57P01', '57P03', '08006', '08001', '08003'];

/**
 * Error handler terpusat: semua error dari rute berakhir di sini dan diterjemahkan menjadi
 * status HTTP + pesan yang jelas. Detail teknis hanya ditulis ke log, tidak dikirim ke pengguna.
 */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = 500;
  let message = 'Terjadi kesalahan pada server.';

  if (err instanceof HttpError) { status = err.status; message = err.message; }
  else if (err.type === 'entity.parse.failed') { status = 400; message = 'Format JSON tidak valid.'; }
  else if (err.type === 'entity.too.large') { status = 413; message = 'Data yang dikirim terlalu besar.'; }
  else if (err.name === 'MulterError') { // error upload file
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400; // 413 = terlalu besar
    message = err.code === 'LIMIT_FILE_SIZE' ? `Ukuran file maksimal ${MAX_UPLOAD_MB} MB.`
      : `Upload tidak valid (maksimal ${MAX_ATTACHMENTS} file, field bernama "files").`;
  }
  else if (err.code === '23503') { status = 400; message = 'Proyek atau kategori tidak ditemukan.'; } // foreign key
  else if (err.code === '23505') { status = 409; message = 'Data sudah ada.'; }                       // unique
  else if (['22007', '22008'].includes(err.code)) { status = 400; message = 'Tanggal tidak valid.'; }
  else if (['22P02', '22001', '23514'].includes(err.code)) { status = 400; message = 'Data tidak valid.'; }
  else if (DB_DOWN_CODES.includes(err.code) || /timeout|terminated|ECONNREFUSED/i.test(err.message || '')) {
    status = 503; message = 'Database sedang tidak tersedia. Coba lagi sebentar lagi.';
  }

  if (status >= 500) log.error(`${req.method} ${req.originalUrl}: ${err.stack || err.message}`); // hanya error server yang dicatat lengkap
  if (res.headersSent) return;
  res.status(status).json({ error: message });
});

// Urutan start: tunggu DB -> terapkan skema -> data contoh -> baru buka port.
let server;
(async () => {
  try {
    await db.waitForDb();
    await db.ensureSchema();
    await db.seedDemo();
  } catch (err) {
    log.error(`Gagal start: ${err.message}`);
    process.exit(1); // keluar agar Docker (restart: unless-stopped) mencoba lagi
  }
  server = app.listen(PORT, () => log.info(`TaskHub berjalan di port ${PORT}`));
})();

// Berhenti dengan rapi saat `docker stop` / Ctrl+C: selesaikan request berjalan, tutup koneksi database.
function shutdown(signal) {
  log.info(`${signal} diterima, menutup server...`);
  const done = () => db.pool.end().finally(() => process.exit(0));
  server ? server.close(done) : done();
  setTimeout(() => process.exit(1), 8000).unref(); // paksa keluar bila macet > 8 detik
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));