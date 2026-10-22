# TaskHub User Guide

TaskHub is a multi-user task and project management app. Use it to organize tasks, track deadlines, manage attachments and subtasks, and review your progress. Each account has its own projects, categories, tasks, and attachments.

## Contents

- [Requirements](#requirements)
- [Start the application](#start-the-application)
- [Sign in or create an account](#sign-in-or-create-an-account)
- [Use TaskHub](#use-taskhub)
- [Manage your data](#manage-your-data)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

## Requirements

- Docker Desktop with Docker Compose, or Docker Engine with the Compose plugin
- A web browser

## Start the application

1. Open a terminal in the project folder.
2. Copy the example environment file:

   **PowerShell**
   ```powershell
   Copy-Item .env.example .env
   ```

   **macOS, Linux, or Git Bash**
   ```bash
   cp .env.example .env
   ```

3. Open `.env` and replace `JWT_SECRET` and `DB_PASSWORD` with your own values. Keep `.env` private; do not share or commit it.
4. Build and start the application:

   ```sh
   docker compose up -d --build
   ```

5. Check that both services are running:

   ```sh
   docker compose ps
   ```

6. Open [http://localhost:3000](http://localhost:3000) in your browser.

The first startup creates the database schema and, when demo data is enabled, the example accounts and sample tasks. Startup may take a little while while PostgreSQL initializes.

## Sign in or create an account

### Example accounts

When demo data is enabled, use one of these accounts:

| Username | Default password |
|---|---|
| `alice` | `demo12345` |
| `bob` | `demo12345` |

The password may be different if `DEMO_PASSWORD` was changed in `.env`. For a public or shared deployment, disable demo data and change all default secrets before starting the app.

Demo accounts are seeded only when the `users` table is empty. If you have already created an account, the demo accounts will not be added automatically.

### Create an account

1. Select **Daftar** (Sign up) on the login page.
2. Enter a username containing 3–30 lowercase letters, numbers, or underscores.
3. Enter a password between 8 and 72 characters.
4. Select **Buat akun** (Create account).

Each new account starts with a default project and categories. Logging out and signing in with another account displays that account's data instead.

## Use TaskHub

### Navigate the app

The interface labels are in Indonesian. Use the view buttons in the header to switch between:

- **Dashboard** — task totals, completion progress, upcoming deadlines, and reminders.
- **Daftar** (List) — create, search, filter, sort, edit, and delete tasks.
- **Papan** (Board) — view tasks in To Do, In Progress, and Done columns. Drag a card between columns or use its arrow buttons.
- **Aktivitas** (Activity) — review recent task and attachment activity.
- **Tong Sampah** (Trash) — restore deleted tasks or delete them permanently.

The sidebar lets you filter by project or category. Select **Semua tugas** (All tasks) to clear those sidebar filters. The database indicator at the bottom of the sidebar shows whether the app can reach PostgreSQL.

### Create and organize tasks

1. Open **Daftar** (List) or **Papan** (Board).
2. Enter a task title. You can also add a description, project, category, priority, and due date.
3. Optionally attach files or add a link.
4. Select **Tambah tugas** (Add task).

Select **Ubah** (Edit) on a task to change its details, manage attachments, or add subtasks. Click the task's status badge or completion button to change its status. Tasks can also be moved between statuses on the Board.

To organize tasks, add projects or categories from the sidebar. Select a project or category to show only its tasks. You can search task titles and descriptions, and filter by status, priority, or due date.

### Subtasks

Open a task with **Edit**, then use the **Subtasks** section to add checklist items. Check an item to mark it complete, or select **Delete** to remove it.

### Attachments and links

You can add attachments when creating a task or later from its edit dialog. The default limits are 5 attachments per task and 5 MB per file.

Supported file types include JPG, PNG, WEBP, GIF, PDF, DOCX, XLSX, PPTX, ZIP, TXT, CSV, and MD. Links must use `http://` or `https://`. Images can be previewed in the app; other files are downloaded.

### Reminders and activity

The **Pengingat** (Reminders) button groups overdue tasks, tasks due today, tasks due soon, and recently added tasks. Select a reminder to find that task in the list. The reminder window and other limits can be changed in `.env`.

The **Aktivitas** (Activity) view records recent task changes and attachment actions for your account.

### Delete and restore tasks

Selecting **Hapus** (Delete) on a task moves it to **Tong Sampah** (Trash); it does not delete it permanently. In Trash, choose **Pulihkan** (Restore) to return a task to your active tasks. **Hapus Permanen** (Delete permanently) cannot be undone and also removes the task's attached files.

## Manage your data

Docker Compose stores PostgreSQL data and uploaded files in named volumes. Stopping or recreating containers does not normally remove this data.

Stop the application while keeping your data:

```sh
docker compose down
```

Start it again:

```sh
docker compose up -d
```

**Warning:** The following command removes the database and uploaded-file volumes, permanently deleting stored data:

```sh
docker compose down -v
```

## Configuration

Edit `.env` before starting or rebuilding the app. Common options:

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `3000` | Port used to open the web app on your computer. |
| `JWT_SECRET` | Example placeholder | Secret used to sign login sessions. Set a long, random value. |
| `DB_USER` | `postgres` | PostgreSQL username. |
| `DB_PASSWORD` | Example placeholder | PostgreSQL password. Choose a private value. |
| `DB_NAME` | `taskhub_db` | PostgreSQL database name. |
| `DB_HOST_PORT` | `5432` | Database port exposed on your computer. Change it if that port is already in use. |
| `COOKIE_SECURE` | `false` | Set to `true` when serving the app over HTTPS. |
| `MAX_UPLOAD_MB` | `5` | Maximum size of each uploaded file, in MB. |
| `MAX_ATTACHMENTS` | `5` | Maximum number of files and links per task. |
| `REMINDER_DAYS` | `3` | Number of days ahead included in the soon-due reminders. |
| `SEED_DEMO_DATA` | `true` | Creates Alice and Bob sample accounts when the database has no users. Set to `false` to disable. |
| `DEMO_PASSWORD` | `demo12345` | Password assigned to the example accounts when they are created. |
| `TZ` | `Asia/Jakarta` | Time zone used by the application and database. |

After changing environment variables, recreate the services so the new values are applied:

```sh
docker compose up -d
```

## Troubleshooting

### The app does not open

Check the service status and application logs:

```sh
docker compose ps
docker compose logs --tail 100 app
```

Confirm that port `3000` is available, or set another `PORT` value in `.env`.

### The database is not ready

Check both service logs:

```sh
docker compose logs --tail 100 db
docker compose logs --tail 100 app
```

The app waits for PostgreSQL during startup. If the database container is still initializing, wait briefly and check `docker compose ps` again.

### The demo login does not work

Check the `DEMO_PASSWORD` value in `.env`. Demo accounts are only created on an empty database; they are not recreated if users already exist.

### Run the smoke test

After the services are running, you can run the optional smoke test from Git Bash or another Bash environment:

```bash
bash scripts/smoke-test.sh
```

The script signs in as both demo users and exercises common API behavior, including account data isolation, task updates, attachments, and input validation.
