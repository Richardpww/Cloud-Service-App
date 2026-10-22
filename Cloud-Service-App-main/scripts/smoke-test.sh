#!/usr/bin/env bash
# =====================================================================
# smoke-test.sh - Uji cepat otomatis untuk TaskHub.
#
# Menguji: health check, login, isolasi data antar pengguna (RLS), proyek,
# status Kanban, lampiran (file dan link), pengingat, dan validasi input.
#
# Cara pakai (setelah `docker compose up -d --build`):
#   bash scripts/smoke-test.sh
# Opsional: BASE_URL=http://localhost:3000 DEMO_PASSWORD=demo12345 bash scripts/smoke-test.sh
# Hasil [LULUS]/[GAGAL] dapat di-screenshot sebagai bukti pengujian.
# =====================================================================
BASE="${BASE_URL:-http://localhost:3000}"
PASS="${DEMO_PASSWORD:-demo12345}"
TMP="$(mktemp -d)"   # folder sementara untuk cookie dan file uji
fails=0              # jumlah uji yang gagal

# check "deskripsi" <diharapkan> <aktual> : bandingkan kode HTTP dan cetak hasilnya
check() {
  if [ "$2" = "$3" ]; then echo "  [LULUS] $1 (HTTP $3)"; else echo "  [GAGAL] $1 (diharapkan $2, dapat $3)"; fails=$((fails+1)); fi
}
# code <argumen curl...> : jalankan curl, tampilkan HANYA kode status HTTP-nya
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# first_id : ambil angka "id" pertama dari JSON yang dikirim lewat stdin
first_id() { grep -o '"id":[0-9]*' | head -1 | cut -d: -f2; }
JSON='Content-Type: application/json'

echo "1. Health check"
check "GET /health" 200 "$(code "$BASE/health")"

echo "2. Login dua pengguna (cookie disimpan per pengguna)"
check "login alice" 200 "$(code -c "$TMP/alice" -H "$JSON" -d "{\"username\":\"alice\",\"password\":\"$PASS\"}" "$BASE/api/auth/login")"
check "login bob"   200 "$(code -c "$TMP/bob"   -H "$JSON" -d "{\"username\":\"bob\",\"password\":\"$PASS\"}" "$BASE/api/auth/login")"
check "password salah ditolak" 401 "$(code -H "$JSON" -d '{"username":"alice","password":"salah-salah"}' "$BASE/api/auth/login")"

echo "3. Isolasi data (Row Level Security)"
ALICE_JSON="$(curl -s -b "$TMP/alice" "$BASE/api/todos")"
BOB_JSON="$(curl -s -b "$TMP/bob" "$BASE/api/todos")"
echo "  alice melihat $(echo "$ALICE_JSON" | grep -o '"title":' | wc -l) tugas, bob melihat $(echo "$BOB_JSON" | grep -o '"title":' | wc -l) tugas"
ALICE_ID="$(echo "$ALICE_JSON" | first_id)"                                  # id satu tugas milik alice
ALICE_PROJECT="$(curl -s -b "$TMP/alice" "$BASE/api/projects" | first_id)"   # id satu proyek milik alice
check "bob membuka tugas alice via status" 404 "$(code -b "$TMP/bob" -X PATCH -H "$JSON" -d '{"status":"done"}' "$BASE/api/todos/$ALICE_ID/status")"
check "bob menghapus tugas alice" 404 "$(code -b "$TMP/bob" -X DELETE "$BASE/api/todos/$ALICE_ID")"
check "bob mengubah proyek alice" 404 "$(code -b "$TMP/bob" -X PUT -H "$JSON" -d '{"name":"x"}' "$BASE/api/projects/$ALICE_PROJECT")"
check "bob menambah lampiran ke tugas alice" 404 "$(code -b "$TMP/bob" -H "$JSON" -d '{"url":"https://example.com"}' "$BASE/api/todos/$ALICE_ID/links")"

echo "4. Proyek, status Kanban, dashboard, pengingat"
check "alice melihat daftar proyek" 200 "$(code -b "$TMP/alice" "$BASE/api/projects")"
check "alice memindahkan tugas ke In Progress" 200 "$(code -b "$TMP/alice" -X PATCH -H "$JSON" -d '{"status":"in_progress"}' "$BASE/api/todos/$ALICE_ID/status")"
check "dashboard alice" 200 "$(code -b "$TMP/alice" "$BASE/api/dashboard")"
check "pengingat alice" 200 "$(code -b "$TMP/alice" "$BASE/api/notifications")"
check "log aktivitas alice" 200 "$(code -b "$TMP/alice" "$BASE/api/activity")"
if curl -s -b "$TMP/bob" "$BASE/api/activity" | grep -q "Laporan praktikum"; then
  echo "  [GAGAL] bob melihat log aktivitas milik alice"; fails=$((fails+1))
else echo "  [LULUS] log aktivitas bob tidak memuat data alice"; fi

echo "5. Lampiran: file dan link"
echo "catatan uji" > "$TMP/catatan.txt"
UPLOAD_JSON="$(curl -s -b "$TMP/alice" -F "files=@$TMP/catatan.txt;type=text/plain" "$BASE/api/todos/$ALICE_ID/files")"
ATT_ID="$(echo "$UPLOAD_JSON" | first_id)"   # id lampiran yang baru dibuat
check "alice mengunggah file teks" 1 "$([ -n "$ATT_ID" ] && echo 1 || echo 0)"
check "alice mengunduh lampirannya" 200 "$(code -b "$TMP/alice" "$BASE/api/attachments/$ATT_ID")"
check "bob mengunduh lampiran alice" 404 "$(code -b "$TMP/bob" "$BASE/api/attachments/$ATT_ID")"
check "bob menghapus lampiran alice" 404 "$(code -b "$TMP/bob" -X DELETE "$BASE/api/attachments/$ATT_ID")"
check "alice menambah link valid" 201 "$(code -b "$TMP/alice" -H "$JSON" -d '{"url":"https://example.com","title":"Contoh"}' "$BASE/api/todos/$ALICE_ID/links")"
check "link berbahaya (javascript:) ditolak" 400 "$(code -b "$TMP/alice" -H "$JSON" -d '{"url":"javascript:alert(1)"}' "$BASE/api/todos/$ALICE_ID/links")"
echo "bukan gambar" > "$TMP/palsu.png"
check "file palsu (isi bukan gambar) ditolak" 400 "$(code -b "$TMP/alice" -F "files=@$TMP/palsu.png;type=image/png" "$BASE/api/todos/$ALICE_ID/files")"
printf 'MZ\x90\x00' > "$TMP/program.exe"
check "file .exe ditolak" 400 "$(code -b "$TMP/alice" -F "files=@$TMP/program.exe" "$BASE/api/todos/$ALICE_ID/files")"
check "alice menghapus lampirannya sendiri" 200 "$(code -b "$TMP/alice" -X DELETE "$BASE/api/attachments/$ATT_ID")"

echo "6. Validasi input"
check "judul kosong" 400 "$(code -b "$TMP/alice" -F 'title=   ' "$BASE/api/todos")"
check "prioritas tidak valid" 400 "$(code -b "$TMP/alice" -F 'title=x' -F 'priority=urgent' "$BASE/api/todos")"
check "tanggal tidak valid" 400 "$(code -b "$TMP/alice" -F 'title=x' -F 'due_date=31-12-2026' "$BASE/api/todos")"
check "proyek milik user lain" 400 "$(code -b "$TMP/bob" -F 'title=x' -F "project_id=$ALICE_PROJECT" "$BASE/api/todos")"
check "status tidak valid" 400 "$(code -b "$TMP/alice" -X PATCH -H "$JSON" -d '{"status":"selesai"}' "$BASE/api/todos/$ALICE_ID/status")"
check "filter prioritas tidak valid" 400 "$(code -b "$TMP/alice" "$BASE/api/todos?priority=urgent")"
check "filter tenggat terlambat" 200 "$(code -b "$TMP/alice" "$BASE/api/todos?due=overdue&priority=high&status=todo")"

echo "7. Akses tanpa login"
check "GET /api/todos tanpa cookie" 401 "$(code "$BASE/api/todos")"
check "GET /api/attachments tanpa cookie" 401 "$(code "$BASE/api/attachments/1")"

# Kembalikan status tugas ke To Do (agar data demo konsisten untuk uji berikutnya)
code -b "$TMP/alice" -X PATCH -H "$JSON" -d '{"status":"todo"}' "$BASE/api/todos/$ALICE_ID/status" >/dev/null
rm -rf "$TMP"
echo; [ "$fails" -eq 0 ] && echo "SEMUA UJI LULUS" || echo "$fails uji GAGAL"
exit "$fails"
