# =====================================================================
# Dockerfile - resep membangun image aplikasi TaskHub
# Dibangun lewat: docker compose up --build  (atau: docker build -t taskhub-app .)
# =====================================================================

# Image dasar: Node.js 20 di atas Alpine Linux (kecil, sekitar 50 MB).
FROM node:20-alpine

# Mode produksi: library dan Express berjalan lebih efisien.
ENV NODE_ENV=production

# Semua perintah berikutnya dijalankan dari folder ini di dalam container.
WORKDIR /usr/src/app

# Salin package.json LEBIH DULU, lalu install dependency.
# Docker menyimpan hasil tiap langkah (layer). Selama package.json tidak berubah,
# langkah npm install yang lama dipakai ulang sehingga build berikutnya jauh lebih cepat.
COPY package*.json ./
RUN npm install --omit=dev

# Baru salin kode aplikasi (server.js, db.js, public/, db/init.sql, dst).
# File yang tidak perlu disaring oleh .dockerignore (node_modules, .env, dll).
COPY . .

# Siapkan folder upload lalu serahkan kepemilikan ke user "node".
# Folder ini di-mount sebagai volume (uploads_data) oleh docker-compose.yml.
RUN mkdir -p /usr/src/app/uploads && chown -R node:node /usr/src/app

# Jalankan sebagai user biasa (bukan root). Bila aplikasi dibobol, dampaknya lebih terbatas.
USER node

# Dokumentasi bahwa aplikasi mendengarkan port 3000 (pemetaan port sebenarnya ada di compose).
EXPOSE 3000

# Docker memanggil /health tiap 15 detik. Gagal 3 kali berturut-turut -> container ditandai "unhealthy".
# wget sudah tersedia di Alpine (busybox), jadi tidak perlu install tambahan.
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Perintah yang dijalankan saat container start.
CMD ["node", "server.js"]
