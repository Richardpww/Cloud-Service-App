const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging Middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Database Connection Setup
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

// Inisialisasi Tabel Database
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todos (
        id SERIAL PRIMARY KEY,
        task VARCHAR(255) NOT NULL,
        completed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Database terhubung dan tabel siap digunakan.');
  } catch (err) {
    console.error('❌ Gagal menginisialisasi database:', err.message);
  }
};
initDb();

// Endpoint Health Check (Untuk Docker Compose)
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'UP', database: 'CONNECTED' });
  } catch (err) {
    res.status(500).json({ status: 'DOWN', database: 'DISCONNECTED', error: err.message });
  }
});

// API Routes (CRUD)
// 1. Ambil Semua Tugas
app.get('/api/todos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM todos ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil data dari database.' });
  }
});

// 2. Tambah Tugas Baru (Validasi Input)
// 2. Tambah Tugas Baru
app.post('/api/todos', async (req, res) => {
  try {
    console.log('[DEBUG] Body yang diterima:', req.body);
    const taskText = req.body.task;
    
    if (!taskText || typeof taskText !== 'string' || taskText.trim() === '') {
      return res.status(400).json({ error: 'Nama tugas tidak boleh kosong!' });
    }

    // Coba eksekusi insert ke database
    const result = await pool.query(
      'INSERT INTO todos (task) VALUES ($1) RETURNING id, task, completed, created_at', 
      [taskText.trim()]
    );
    
    console.log(`[LOG] Sukses menambah tugas ke DB: "${taskText.trim()}"`);
    return res.status(201).json(result.rows[0]);
    
  } catch (err) {
    // INI PENTING: Cetak error aslinya ke terminal Docker agar terlihat
    console.error('❌ DETAIL ERROR SQL SAAT INSERT:', err);
    return res.status(500).json({ error: 'Gagal menambah tugas: ' + err.message });
  }
});

// 3. Ubah Status Tugas (Toggle Completed)
app.put('/api/todos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const current = await pool.query('SELECT completed FROM todos WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
    }
    const newStatus = !current.rows[0].completed;
    const result = await pool.query('UPDATE todos SET completed = $1 WHERE id = $2 RETURNING *', [newStatus, id]);
    console.log(`[LOG] Status tugas ID ${id} diubah menjadi: ${newStatus}`);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Gagal memperbarui tugas.' });
  }
});

// 4. Hapus Tugas
app.delete('/api/todos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM todos WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
    }
    console.log(`[LOG] Tugas ID ${id} berhasil dihapus.`);
    res.json({ message: 'Tugas berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menghapus tugas.' });
  }
});

// Frontend HTML Simple Interface
// Frontend HTML Simple Interface (Ganti bagian res.send(...) di server.js dengan ini)
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <title>Task Manager - Cloud Project</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 500px; margin: 40px auto; padding: 20px; border: 1px solid #ccc; border-radius: 8px; }
        h2 { text-align: center; }
        .input-group { display: flex; gap: 10px; margin-bottom: 20px; }
        input[type="text"] { flex: 1; padding: 8px; font-size: 14px; }
        button { padding: 8px 12px; cursor: pointer; background-color: #28a745; color: white; border: none; border-radius: 4px; }
        ul { list-style: none; padding: 0; }
        li { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #eee; }
        .completed { text-decoration: line-through; color: #888; }
        .delete-btn { background-color: #dc3545; padding: 4px 8px; font-size: 12px; }
        .error { color: red; font-size: 14px; margin-bottom: 10px; display: none; }
      </style>
    </head>
    <body>
      <h2>Aplikasi To-Do List (Dockerized)</h2>
      <div id="error-msg" class="error"></div>
      <div class="input-group">
        <input type="text" id="taskInput" placeholder="Masukkan tugas baru...">
        <button id="addBtn">Tambah</button>
      </div>
      <ul id="todoList"></ul>

      <script>
        async function fetchTodos() {
          try {
            const res = await fetch('/api/todos');
            const data = await res.json();
            const list = document.getElementById('todoList');
            list.innerHTML = '';
            data.forEach(todo => {
              list.innerHTML += \`
                <li>
                  <span class="\${todo.completed ? 'completed' : ''}" onclick="toggleTodo(\${todo.id})" style="cursor:pointer">
                    \${todo.task}
                  </span>
                  <button class="delete-btn" onclick="deleteTodo(\${todo.id})">Hapus</button>
                </li>
              \`;
            });
          } catch (err) {
            console.error("Gagal memuat data:", err);
          }
        }

        async function addTodo() {
          const input = document.getElementById('taskInput');
          const errorMsg = document.getElementById('error-msg');
          errorMsg.style.display = 'none';

          const taskValue = input.value.trim();
          if (!taskValue) {
            errorMsg.innerText = "Nama tugas tidak boleh kosong!";
            errorMsg.style.display = 'block';
            return;
          }

          try {
            const res = await fetch('/api/todos', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ task: taskValue })
            });

            if (!res.ok) {
              const err = await res.json();
              errorMsg.innerText = err.error || "Gagal menambah tugas.";
              errorMsg.style.display = 'block';
              return;
            }

            input.value = '';
            fetchTodos();
          } catch (err) {
            console.error("Error koneksi:", err);
          }
        }

        async function toggleTodo(id) {
          await fetch('/api/todos/' + id, { method: 'PUT' });
          fetchTodos();
        }

        async function deleteTodo(id) {
          await fetch('/api/todos/' + id, { method: 'DELETE' });
          fetchTodos();
        }

        // Pasang event listener secara aman pada tombol
        document.getElementById('addBtn').addEventListener('click', addTodo);
        
        // Load data awal saat halaman dibuka
        fetchTodos();
      </script>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});