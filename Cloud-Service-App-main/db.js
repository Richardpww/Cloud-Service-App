/**
 * db.js - Koneksi PostgreSQL, penerapan skema, helper RLS, dan data contoh.
 *
 * Modul ini dipakai server.js. Semua akses database dari aplikasi lewat file ini.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const log = require('./logger');

/**
 * Pool koneksi: kumpulan koneksi yang dipakai bergantian oleh banyak request.
 * Nilai diambil dari environment variable (diisi docker-compose.yml dari file .env).
 * DB_HOST bernilai "db", yaitu nama service database di jaringan Docker Compose.
 */
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 10,                        // maksimal 10 koneksi bersamaan
  connectionTimeoutMillis: 3000,  // jangan menunggu lebih dari 3 detik (agar /health cepat gagal saat DB mati)
});

// Tanpa handler ini, koneksi idle yang terputus (mis. container database di-stop)
// akan memicu "unhandled error" dan membuat Node crash. Cukup dicatat; pool menyambung ulang sendiri.
pool.on('error', (err) => log.error(`Koneksi database terputus: ${err.message}`));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Menunggu database siap. Saat `docker compose up`, container database bisa saja
 * masih menyiapkan diri; kita coba berulang (maks 30 x 2 detik) sebelum menyerah.
 */
async function waitForDb(retries = 30, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query('SELECT 1');
      log.info('Database terhubung.');
      return;
    } catch (err) {
      log.warn(`Menunggu database (${i}/${retries}): ${err.message}`);
      await sleep(delayMs);
    }
  }
  throw new Error('Database tidak dapat dihubungi.');
}

/**
 * Menjalankan db/init.sql. Karena skrip itu idempotent, aman dipanggil di setiap start,
 * dan sekaligus memigrasi database lama (kolom completed -> status, image_path -> attachments, dst).
 */
async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'init.sql'), 'utf8');
  await pool.query(sql);
  log.info('Skema database siap (tabel + Row Level Security).');
}

/**
 * withUser: jalankan sekumpulan query "sebagai pengguna tertentu" di bawah RLS.
 *
 * Langkah di dalam satu transaksi:
 *   1. SET LOCAL ROLE app_rls   -> turun dari superuser ke role yang tunduk pada RLS
 *   2. set_config(...)          -> tandai siapa pengguna aktif (dibaca oleh policy RLS)
 *   3. jalankan fn(client)      -> query-query milik pengguna itu
 *   4. COMMIT, atau ROLLBACK bila ada error
 * "LOCAL" membuat kedua pengaturan hilang otomatis di akhir transaksi, jadi tidak bocor
 * ke request pengguna lain yang kebetulan memakai koneksi yang sama.
 */
async function withUser(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_rls');
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [String(userId)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* koneksi sudah putus, abaikan */ }
    throw err;
  } finally {
    client.release(); // kembalikan koneksi ke pool
  }
}

/**
 * Data contoh untuk demo. Format tiap tugas:
 *   [judul, catatan, prioritas, selisih hari tenggat dari hari ini (null = tanpa tenggat),
 *    indeks kategori, status, indeks proyek (null = tanpa proyek)]
 * Selisih negatif = sudah lewat tenggat (menghasilkan contoh tugas "terlambat").
 */
const DEMO = [
  {
    username: 'alice',
    projects: [['Cloud Services', '#1d4ed8'], ['Dies Natalis', '#be185d']],
    categories: [['Kuliah', '#0f766e'], ['Pribadi', '#c2410c'], ['Organisasi', '#6d28d9']],
    todos: [
      ['Laporan praktikum Docker', 'Lampirkan screenshot docker ps dan docker volume ls', 'high', 1, 0, 'in_progress', 0],
      ['Baca materi Week 5: Dockerfile', '', 'medium', 3, 0, 'todo', 0],
      ['Analisis HTTP header dengan curl', 'Bandingkan respons GET dan POST', 'high', -1, 0, 'todo', 0],
      ['Rapat panitia dies natalis', 'Bawa notulen rapat sebelumnya', 'medium', 0, 2, 'todo', 1],
      ['Susun rundown acara', '', 'low', 6, 2, 'done', 1],
      ['Beli buku catatan', '', 'low', null, 1, 'done', null],
    ],
    // [indeks tugas, judul link, url]
    links: [[0, 'Dokumentasi Docker Compose', 'https://docs.docker.com/compose/']],
  },
  {
    username: 'bob',
    projects: [['Proyek Kelompok Cloud', '#0f766e']],
    categories: [['Proyek Kelompok', '#1d4ed8'], ['Belanja', '#be185d']],
    todos: [
      ['Siapkan slide presentasi UTS', '10 menit presentasi + 5 menit tanya jawab', 'high', 2, 0, 'in_progress', 0],
      ['Tulis README dan .env.example', '', 'medium', 1, 0, 'todo', 0],
      ['Push repo ke GitHub', '', 'medium', -2, 0, 'done', 0],
      ['Beli kabel LAN', '', 'low', null, 1, 'todo', null],
    ],
    links: [],
  },
];

/**
 * Membuat akun contoh (alice, bob) beserta data mereka, HANYA bila tabel users masih kosong
 * dan SEED_DEMO_DATA=true. Password diambil dari DEMO_PASSWORD dan langsung di-hash.
 */
async function seedDemo() {
  if (process.env.SEED_DEMO_DATA !== 'true') return;
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return; // sudah ada pengguna, jangan timpa

  const hash = await bcrypt.hash(process.env.DEMO_PASSWORD || 'demo12345', 10);
  for (const u of DEMO) {
    // Tabel users tidak boleh disentuh role app_rls, jadi dimasukkan lewat pool biasa.
    const { rows: [user] } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id', [u.username, hash]);

    // Sisanya dimasukkan lewat withUser agar prosesnya sama dengan jalur aplikasi sungguhan.
    await withUser(user.id, async (c) => {
      const projectIds = [];
      for (const [name, color] of u.projects) {
        const r = await c.query('INSERT INTO projects (user_id, name, color) VALUES ($1, $2, $3) RETURNING id', [user.id, name, color]);
        projectIds.push(r.rows[0].id);
      }
      const categoryIds = [];
      for (const [name, color] of u.categories) {
        const r = await c.query('INSERT INTO categories (user_id, name, color) VALUES ($1, $2, $3) RETURNING id', [user.id, name, color]);
        categoryIds.push(r.rows[0].id);
      }
      const todoIds = [];
      for (const [title, desc, prio, offset, cat, status, proj] of u.todos) {
        const r = await c.query(
          `INSERT INTO todos (user_id, category_id, project_id, title, description, priority, due_date, status)
           VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE CURRENT_DATE + $7::int END, $8)
           RETURNING id`,
          [user.id, categoryIds[cat], proj === null ? null : projectIds[proj], title, desc, prio, offset, status]);
        todoIds.push(r.rows[0].id);
        await c.query("INSERT INTO activity_log (user_id, todo_id, action, detail) VALUES ($1, $2, 'created', $3)",
          [user.id, r.rows[0].id, `"${title}"`]);
      }
      for (const [idx, name, url] of u.links) {
        await c.query("INSERT INTO attachments (user_id, todo_id, kind, name, url) VALUES ($1, $2, 'link', $3, $4)",
          [user.id, todoIds[idx], name, url]);
      }
    });
  }
  log.info('Data contoh dibuat: akun alice dan bob.');
}

module.exports = { pool, waitForDb, ensureSchema, withUser, seedDemo };
