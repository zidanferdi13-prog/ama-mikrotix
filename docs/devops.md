# Panduan Deploy & Operasional

Dokumen ini menjelaskan cara men-deploy dan mengoperasikan Project Monitoring AP.
Sumber spesifikasi tetap `docs/konsep-mvp.md`; dokumen ini turunannya dan tidak mengubah keputusan di sana.

> Status: **belum final**. Autostart/restart service, backup, dan retensi sengaja
> ditunda (lihat bagian *Yang belum ditentukan*). OS/lokasi server target juga
> belum dikonfirmasi, jadi contoh service di sini bersifat ilustrasi, bukan asumsi.

## 1. Ringkasan arsitektur

Tiga proses terpisah, satu database:

```
collector  ──(ping + SSH read-only)──► MariaDB ──(baca)──► server (REST + Socket.IO) ──► browser (dashboard)
   │                                                        │
   └── heartbeat ──────────────────────────────────────────►└── /api/health
```

- `apps/collector` — ping 15s + SSH 60s per AP, tulis sampel + heartbeat ke DB.
- `apps/server` — REST API + Socket.IO di port `3001`.
- `apps/web` — dashboard React (hasil build statis).

Server **tidak** menyajikan file statis dashboard. Perlu reverse-proxy (nginx)
untuk melayani `apps/web/dist` dan meneruskan `/api` + `/socket.io` ke `:3001`.

## 2. Prasyarat server

- Node.js 20 (lihat `.nvmrc`; `engines` membatasi `>=20 <21`).

  ```bash
  nvm install && nvm use
  node -v   # harus v20.x
  ```

- MariaDB 10.x berjalan dan dapat diakses collector + server.
- Host server boleh menjangkau 3 AP (`192.168.5.228`, `.226`, `.120`) di port 22 dan ICMP.
- Akun monitoring dengan hak minimum di AP (perubahan akun AP perlu izin terpisah).
- (Opsional) nginx untuk HTTPS dan pembatasan akses jaringan.

## 3. Ambil kode dan dependensi

```bash
git clone <repo> ama-mikrotik
cd ama-mikrotik
npm ci
```

Untuk menjalankan tes cepat sebelum deploy:

```bash
npm test
```

## 4. Siapkan database

```bash
mysql -u root -p < db/migrations/001_init.sql
mysql -u root -p < db/migrations/002_heartbeat.sql
mysql -u root -p < db/seed/001_devices.sql
```

Buat akun aplikasi berhak minimum (jangan pakai `root`):

```sql
CREATE USER 'ama_app'@'127.0.0.1' IDENTIFIED BY '<password-kuat>';
GRANT SELECT, INSERT, UPDATE ON ama_monitoring.* TO 'ama_app'@'127.0.0.1';
FLUSH PRIVILEGES;
```

Seed hanya membuat 3 AP + baris heartbeat. Tidak ada halaman CRUD perangkat —
perubahan inventaris dilakukan lewat SQL.

## 5. Konfigurasi dan rahasia

```bash
cp .env.example .env
cp config/devices.example.json config/devices.json
```

Isi `.env` (jangan commit):

- Kredensial DB: `AMA_DB_HOST`, `AMA_DB_PORT`, `AMA_DB_USER`, `AMA_DB_PASSWORD`, `AMA_DB_NAME`.
- Auth dashboard: `AMA_AUTH_USER`, `AMA_AUTH_PASSWORD`, `AMA_JWT_SECRET` (acak, panjang).
- `AMA_WEB_ORIGIN` = origin dashboard sebenarnya (mis. `https://monitor.internal`).
- Bila di belakang HTTPS: `AMA_COOKIE_SECURE=true`.

Isi `config/devices.json` (tanpa rahasia): `id`, `name`, `ip`, `username`, `port`,
dan `hostKeyFingerprint` format `sha256:...` per AP.

Rahasia SSH **tidak boleh** masuk `config/devices.json`, Git, argumen command line, atau log.
Dua opsi:

- Env: `AMA_DEVICE_1_PASSWORD=...` (satu per `devices.id`).
- File di luar repo: `AMA_SECRETS_FILE=/etc/ama/secrets.json`

  ```json
  { "1": "<password-AP1>", "2": "<password-AP2>", "3": "<password-AP3>" }
  ```

  ```bash
  chmod 600 /etc/ama/secrets.json
  chown ama:ama /etc/ama/secrets.json
  ```

`hostKeyFingerprint` kosong → koleksi ditolak dengan `host_key_unpinned`. Ini disengaja:
verifikasi host key tidak boleh dimatikan. Ambil fingerprint tepercaya lewat kanal aman,
jangan dengan `StrictHostKeyChecking=no`.

## 6. Build dashboard

```bash
npm run build -w @ama/web
```

Hasil ada di `apps/web/dist/`.

## 7. Jalankan proses

Jalankan dari root repo:

```bash
npm run collector   # ping + SSH + heartbeat
npm run server      # REST + Socket.IO di :3001
```

Untuk menjalankan tanpa terminal yang menempel, pakai `pm2`, `systemd`, atau
Task Scheduler Windows (belum disiapkan — lihat bagian terakhir).

## 8. Reverse-proxy (nginx)

Contoh: melayani dashboard statis + proxy API dan WebSocket.

```nginx
server {
  listen 443 ssl;
  server_name monitor.internal;

  ssl_certificate     /etc/ssl/certs/monitor.crt;
  ssl_certificate_key /etc/ssl/private/monitor.key;

  root /srv/ama-mikrotik/apps/web/dist;
  location / {
    try_files $uri /index.html;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location /socket.io/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

Tanpa HTTPS, `AMA_COOKIE_SECURE` harus `false`, dan dashboard/API **tidak** dibuka ke internet.

## 9. Cek kesehatan

```bash
curl -s localhost:3001/api/health
```

Respons sehat:

```json
{ "ok": true, "db": { "ok": true, "code": null }, "collector": { "ok": true, "code": null } }
```

Tafsir kode:

| Kondisi | Arti | Tindakan |
|---|---|---|
| `db.code = db_unavailable` | MariaDB tak terjangkau | Cek service DB, kredensial, jaringan |
| `collector.code = collector_stale` | Heartbeat > 90s | Collector mati/terhambat → **data menua**, bukan semua AP down |
| `collector.code = no_heartbeat` | Belum pernah jalan | Jalankan collector, cek migrasi `002_heartbeat.sql` |

Penting: collector mati berarti data **stale**. Jangan tampilkan itu sebagai "semua AP down".

## 10. Pemecahan masalah

- **`no secret configured for device N`** — rahasia tidak terbaca. Cek `AMA_DEVICE_N_PASSWORD`
  atau isi/izin `AMA_SECRETS_FILE`.
- **Semua koleksi sistem gagal, ping tetap OK** — cek `hostKeyFingerprint` (harus cocok),
  kredensial SSH, dan port. Ping sukses tidak berarti SSH sukses.
- **Dashboard kosong / 401** — cookie sesi HttpOnly butuh same-origin; pastikan
  `AMA_WEB_ORIGIN` benar dan akses lewat reverse-proxy (bukan port berbeda).
- **Realtime tidak jalan** — `/socket.io` belum mem-proxy WebSocket (butuh header `Upgrade`).
- **Log** — JSON ke stdout/stderr: hanya device ID, waktu, durasi, status, kode error aman.
  Tidak ada rahasia/isi mentah. Verifikasi koleksi nyata lewat log collector, bukan fixture.

## 11. Backup

Disarankan sebelum uji operasional berkelanjutan. Contoh dump harian:

```bash
mysqldump -u ama_app -p ama_monitoring | gzip > /var/backups/ama-$(date +%F).sql.gz
```

Simpan di luar host aplikasi, batasi akses file, dan uji restore secara berkala.
Jangan campur backup dengan file `.env`/rahasia dalam satu arsip tanpa enkripsi.

## 12. Yang belum ditentukan

Item berikut menunggu keputusan (rujuk `docs/konsep-mvp.md` §9.9 dan §12):

- **Autostart/restart service** — pilih `systemd` (Linux), Task Scheduler/NSSM (Windows),
  atau `pm2`. `systemd` hanya salah satu opsi dan bukan asumsi.
- **Retensi histori** — belum ada penghapusan otomatis; jangan aktifkan tanpa persetujuan.
- **Jadwal backup & uji restore** — belum disepakati.
- **OS/lokasi server target** — belum dikonfirmasi; mesin lokal Windows bukan otomatis server produksi.

Setelah item di atas diputuskan, tambahkan unit service contoh dan jadwal backup di dokumen ini.
