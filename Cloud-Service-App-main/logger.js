/**
 * logger.js - Pencatat log sederhana.
 *
 * Semua log ditulis ke stdout. Docker menangkapnya, sehingga bisa dilihat dengan:
 *   docker compose logs -f app
 * Format: waktu (ISO) [LEVEL] pesan   -> mudah dibaca dan mudah difilter dengan grep.
 */
const write = (level, msg) => console.log(`${new Date().toISOString()} [${level}] ${msg}`);

module.exports = {
  info: (msg) => write('INFO', msg),   // kejadian normal (request, login, aktivitas)
  warn: (msg) => write('WARN', msg),   // perlu perhatian tapi belum error (login gagal, menunggu database)
  error: (msg) => write('ERROR', msg), // ada yang rusak (database mati, error server)
};
