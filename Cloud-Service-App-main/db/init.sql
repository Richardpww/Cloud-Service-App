-- =====================================================================
-- TaskHub - Skema database PostgreSQL
--
-- File ini IDEMPOTENT: aman dijalankan berulang kali. Dipakai dengan dua cara:
--   1. Postgres menjalankannya otomatis saat volume masih kosong
--      (lewat /docker-entrypoint-initdb.d di docker-compose.yml).
--   2. Aplikasi menjalankannya lagi setiap start (db.js -> ensureSchema),
--      sehingga database dari versi lama ikut "dimigrasi" tanpa menghapus data.
--
-- Urutan: tabel inti -> migrasi -> lampiran -> log -> role dan RLS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- =====================================================================
-- TaskHub - Skema database PostgreSQL
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tabel inti
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(30) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       VARCHAR(60) NOT NULL CHECK (length(btrim(name)) > 0),
  color      VARCHAR(7) NOT NULL DEFAULT '#1d4ed8' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name),
  UNIQUE (id, user_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id      SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    VARCHAR(40) NOT NULL CHECK (length(btrim(name)) > 0),
  color   VARCHAR(7) NOT NULL DEFAULT '#0f766e' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  UNIQUE (user_id, name),
  UNIQUE (id, user_id)
);

CREATE TABLE IF NOT EXISTS todos (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INT,
  title       VARCHAR(120) NOT NULL CHECK (length(btrim(title)) > 0),
  description TEXT NOT NULL DEFAULT '',
  priority    VARCHAR(6) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  due_date    DATE,
  status      VARCHAR(12) NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
  is_deleted  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT todos_id_user_key UNIQUE (id, user_id),
  FOREIGN KEY (category_id, user_id) REFERENCES categories (id, user_id) ON DELETE SET NULL (category_id)
);

-- ---------------------------------------------------------------------
-- 2. Migrasi dari versi lama
-- ---------------------------------------------------------------------
DO $$
BEGIN
  ALTER TABLE todos ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'done'));
  IF EXISTS (SELECT FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'todos' AND column_name = 'completed') THEN
    UPDATE todos SET status = 'done' WHERE completed;
    ALTER TABLE todos DROP COLUMN completed;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'todos_id_user_key') THEN
    ALTER TABLE todos ADD CONSTRAINT todos_id_user_key UNIQUE (id, user_id);
  END IF;

  ALTER TABLE todos ADD COLUMN IF NOT EXISTS project_id INT;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'todos_project_fk') THEN
    ALTER TABLE todos ADD CONSTRAINT todos_project_fk
      FOREIGN KEY (project_id, user_id) REFERENCES projects (id, user_id) ON DELETE SET NULL (project_id);
  END IF;

  ALTER TABLE todos ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;
END $$;

CREATE INDEX IF NOT EXISTS idx_todos_user    ON todos (user_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_todos_project ON todos (project_id);

-- ---------------------------------------------------------------------
-- 3. Lampiran
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  todo_id     INT NOT NULL,
  kind        VARCHAR(4) NOT NULL CHECK (kind IN ('file', 'link')),
  name        VARCHAR(150) NOT NULL,
  url         VARCHAR(500),
  stored_name VARCHAR(100),
  mime_type   VARCHAR(100),
  size_bytes  INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (todo_id, user_id) REFERENCES todos (id, user_id) ON DELETE CASCADE,
  CHECK ((kind = 'file' AND stored_name IS NOT NULL) OR (kind = 'link' AND url IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_attachments_todo ON attachments (todo_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'todos' AND column_name = 'image_path') THEN
    INSERT INTO attachments (user_id, todo_id, kind, name, stored_name, mime_type)
    SELECT user_id, id, 'file', 'Gambar lama', image_path,
           CASE right(image_path, 4)
             WHEN '.png' THEN 'image/png' WHEN '.gif' THEN 'image/gif' WHEN 'webp' THEN 'image/webp'
             ELSE 'image/jpeg' END
    FROM todos WHERE image_path IS NOT NULL;
    ALTER TABLE todos DROP COLUMN image_path;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4. Log aktivitas
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  todo_id    INT,
  action     VARCHAR(20) NOT NULL,
  detail     VARCHAR(200) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_action_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_action_check
  CHECK (action IN ('created', 'updated', 'status_changed', 'deleted', 'attachment_added', 'attachment_removed'));
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log (user_id, id DESC);

-- ---------------------------------------------------------------------
-- 5. Sub-Tugas (Checklist)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subtasks (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  todo_id     INT NOT NULL,
  title       VARCHAR(120) NOT NULL CHECK (length(btrim(title)) > 0),
  is_done     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (todo_id, user_id) REFERENCES todos (id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subtasks_todo ON subtasks (todo_id);

-- ---------------------------------------------------------------------
-- 6. Role dan Row Level Security (RLS)
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rls') THEN
    CREATE ROLE app_rls NOLOGIN;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON projects, categories, todos, attachments, subtasks TO app_rls;
GRANT SELECT, INSERT ON activity_log TO app_rls;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rls;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects', 'categories', 'todos', 'attachments', 'activity_log', 'subtasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS owner_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY owner_isolation ON %I FOR ALL TO app_rls
        USING      (user_id = NULLIF(current_setting('app.current_user_id', true), '')::int)
        WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::int)
    $f$, t);
  END LOOP;
END $$;