# Panduan Deploy & Operasional

Dokumen ini menjelaskan cara men-deploy dan mengoperasikan Project Monitoring AP.
Sumber spesifikasi tetap `docs/konsep-mvp.md`; dokumen ini turunannya dan tidak mengubah keputusan di sana.

> Status: autostart (`systemd`) dan OS/lokasi host sudah diputuskan — lihat §12.
> Retensi histori dan jadwal backup masih terbuka. Contoh di dokumen ini mengikuti
> host deploy saat ini (§0); sesuaikan bila pindah host.

## 0. Jalur cepat (host ini)

Host saat ini: Raspberry Pi, Debian 13 (arm64), LAN `192.168.0.103`; 3 AP di `192.168.5.0/24`
dijangkau lewat router. Node 20 dipasang user-space di `~/.local/node-v20.19.5-linux-arm64/`
karena paket `nodejs` apt adalah v24 (di luar `engines >=20 <21`).

```bash
npm ci
node node_modules/esbuild/install.js     # npm 11 memblokir install script; tanpa ini build gagal
npm run build -w @ama/web
cp .env.example .env                     # isi nilai; lihat §5
sudo scripts/provision-host.sh           # DB + nginx + systemd + migrasi/seed; idempoten
sudo systemctl restart ama-server ama-collector
curl -s localhost:3001/api/health
```

Jalankan ulang `sudo scripts/provision-host.sh` setelah setiap `npm run build -w @ama/web`
agar `dist` tersinkron ke `/srv/ama-mikrotix/apps/web/dist` (§6).

## 1. Ringkasan arsitektur

Tiga proses terpisah, satu database:

```
collector  ──(ping + SSH read-only)──► MariaDB ──(baca)──► server (REST + Socket.IO) ──► browser (dashboard)
   │                                                        │
   └── heartbeat ──────────────────────────────────────────►└── /api/health
```

- `apps/collector` — daftar AP dibaca dari tabel `devices` (disegarkan tiap 15 s), ping 15 s
  + SSH 60 s per AP aktif, tulis sampel + heartbeat ke DB.
- `apps/server` — REST API + Socket.IO di port `3001`.
- `apps/web` — dashboard React (hasil build statis).

Server **tidak** menyajikan file statis dashboard. Perlu reverse-proxy (nginx)
untuk melayani `apps/web/dist` dan meneruskan `/api` + `/socket.io` ke `:3001`.

## 2. Prasyarat server

- Node.js 20 (lihat `.nvmrc`; `engines` membatasi `>=20 <21`). Paket `nodejs` dari apt di
  host ini adalah v24, jadi Node 20 dipasang user-space di
  `~/.local/node-v20.19.5-linux-arm64/bin/node` dan dipakai unit systemd; timpa dengan
  `AMA_NODE_BIN` bila lokasinya berbeda.
- MariaDB 11 (`mariadb-server`) dan nginx dipasang oleh `scripts/provision-host.sh` (§0).
- Host server boleh menjangkau 3 AP (`192.168.5.228`, `.226`, `.120`) di port 22 dan ICMP.
- Akun monitoring dengan hak minimum di AP (perubahan akun AP perlu izin terpisah).

## 3. Ambil kode dan dependensi

```bash
git clone <repo> ama-mikrotik
cd ama-mikrotik
npm ci
node node_modules/esbuild/install.js   # npm 11 memblokir install script paket
```

Untuk menjalankan tes cepat sebelum deploy:

```bash
npm test
```

## 4. Siapkan database

`scripts/provision-host.sh` membuat database `ama_monitoring`, akun aplikasi berhak minimum
(`SELECT, INSERT, UPDATE, DELETE`, jangan `root`), dan file rahasia §5 — lalu menerapkan
`db/migrations/*.sql` dan `db/seed/*.sql` sebagai root (akun aplikasi sengaja tanpa hak DDL).

Alternatif tanpa sudo untuk migrasi, bila akun DB di `.env` memang punya hak DDL:

```bash
npm run migrate   # db/migrations/*.sql lalu db/seed/*.sql, idempoten
```

`db/seed/001_devices.sql` hanya **mengisi** tiga AP awal bila barisnya belum ada
(`INSERT IGNORE`). Setelah itu inventaris dipegang tabel `devices` dan diubah dari halaman
**Perangkat** di dashboard — bukan lagi lewat SQL atau berkas di repo.

Migrasi `005_alerts.sql` (aditif, idempoten) menambah tabel `alerts`, `alert_events`, dan
`client_observations`. Terapkan **sebelum** me-restart collector; bila belum diterapkan,
collector tetap menulis metrik seperti biasa dan hanya mencatat `alert_eval_failed` pada log.
Rollback: kembalikan kode ke revisi sebelumnya lalu `sudo systemctl restart ama-server
ama-collector` — tabel baru diabaikan kode lama dan tidak perlu dihapus. Menghapus tabel itu
**menghilangkan seluruh riwayat alert**, jadi lakukan hanya bila memang dikehendaki.

## 5. Konfigurasi dan rahasia

```bash
cp .env.example .env
```

Isi `.env` (jangan commit). Nilai dibaca saat service start, jadi setelah mengubahnya
jalankan `sudo systemctl restart ama-server ama-collector`:

- Kredensial DB: `AMA_DB_HOST`, `AMA_DB_PORT`, `AMA_DB_USER`, `AMA_DB_PASSWORD`, `AMA_DB_NAME`.
- Auth dashboard: `AMA_AUTH_USER`, `AMA_AUTH_PASSWORD`, `AMA_JWT_SECRET` (acak, panjang).
- `AMA_WEB_ORIGIN` = origin dashboard sebenarnya (mis. `https://monitor.internal`).
- Bila di belakang HTTPS: `AMA_COOKIE_SECURE=true`.
- `AMA_DEVICE_REFRESH_MS` (default `15000`) — jeda collector menyegarkan daftar AP dari DB.

Inventaris AP (nama, ip, port, username, vendor/model/firmware, catatan, aktif/nonaktif)
ada di tabel `devices` dan diubah dari halaman **Perangkat**: tambah, ubah, nonaktifkan,
hapus (hanya bila AP belum punya histori), dan atur rahasia.

Fingerprint host key diambil lewat tombol **Uji & ambil fingerprint** pada form; hasilnya
baru dipakai setelah Anda menekan simpan. Fingerprint kosong → koleksi ditolak dengan
`host_key_unpinned`. Ini disengaja: verifikasi host key tidak boleh dimatikan dan fingerprint
tidak pernah dipercaya otomatis, jadi jangan pakai `StrictHostKeyChecking=no`.

Rahasia SSH **tidak boleh** masuk DB, Git, argumen command line, atau log. Dua opsi:

- File di luar repo (dipakai host ini): `AMA_SECRETS_FILE=/etc/ama/secrets.json`, berisi
  `{ "1": "<password-AP1>", "2": "<password-AP2>" }` dengan kunci `devices.id`, mode `600`,
  dimiliki user layanan. Server menulis berkas ini saat password diisi dari halaman
  Perangkat (temp + rename), dan collector membacanya ulang setiap kali menyambung — tidak
  perlu restart.

  ```bash
  chmod 600 /etc/ama/secrets.json
  chown ama:ama /etc/ama/secrets.json
  ```

- Env: `AMA_DEVICE_<id>_PASSWORD=...` (menang atas berkas), berguna untuk uji sementara.

## 6. Build dashboard

```bash
npm run build -w @ama/web
```

Hasil ada di `apps/web/dist/`.

Nginx (user `www-data`) tidak dapat menembus `~ama-i` yang bermode `700`. Karena itu skrip
provision menyalin `apps/web/dist` ke `/srv/ama-mikrotix/apps/web/dist`, dan nginx melayani
salinan itu — jalankan ulang skrip setelah setiap build.

Setelah salinan ini diterbitkan, **buka dashboard di browser** dan pastikan halaman login/ringkasan
benar-benar tampil. Build tidak melakukan pemeriksaan tipe, jadi identifier yang salah (mis.
variabel state yang terhapus) hanya muncul sebagai layar kosong di browser, bukan sebagai error build.

## 7. Jalankan proses

Jalankan dari root repo (`.env` dimuat otomatis lewat `--env-file-if-exists`):

```bash
npm run collector   # ping + SSH + heartbeat
npm run server      # REST + Socket.IO di :3001
```

Di host ini keduanya berjalan sebagai unit systemd `ama-server` dan `ama-collector`
(dipasang `scripts/provision-host.sh`, `Restart=on-failure`):

```bash
systemctl status ama-server ama-collector
journalctl -u ama-collector -f
```

Catatan penting: proses memaksa `TZ=UTC` (`apps/server/src/index.js`,
`apps/collector/src/main.js`) karena driver MariaDB membaca kolom `DATETIME` sebagai waktu
lokal — tanpa itu kesegaran data dan sumbu waktu grafik bergeser sebesar offset zona host.

Collector juga menjalankan job alert (rule engine + korelasi, tiap 15 s, transaksi sendiri
setelah metrik ter-commit). Perubahan ambang di `packages/shared/src/constants.js` berlaku
setelah `sudo systemctl restart ama-collector`; perubahan tampilan Alert Center butuh build
ulang dashboard (§6). Server hanya membaca tabel alert untuk API dan realtime.

## 8. Reverse-proxy (nginx)

Konfigurasi dipasang oleh `scripts/provision-host.sh` ke
`/etc/nginx/sites-available/ama-mikrotix.conf`: listen 80 (tanpa TLS, LAN saja), root
`/srv/ama-mikrotix/apps/web/dist`, proxy `/api/` dan `/socket.io/` ke `127.0.0.1:3001`.
Versi dengan HTTPS:

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

Instalasi aktual memakai port 80 tanpa TLS (LAN); blok `443 ssl` di atas hanya contoh
bila TLS ditambahkan.

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

- **`code:no_secret` pada log `collect`** — belum ada entri rahasia untuk `devices.id` itu.
  Isi password lewat halaman Perangkat (atau berkas `AMA_SECRETS_FILE`); collector membaca
  berkas itu ulang setiap siklus sehingga tidak perlu restart.
- **`job_failed` pada log collector** — kegagalan di luar dugaan (bukan kegagalan koneksi);
  `code` berisi pesan error. Kegagalan koneksi/SSH justru muncul sebagai `collect` dengan
  `status:error`, bukan `job_failed`.
- **Semua koleksi sistem gagal, ping tetap OK** — cek `hostKeyFingerprint` (harus cocok),
  kredensial SSH, dan port. Ping sukses tidak berarti SSH sukses.
- **Dashboard kosong / 401** — cookie sesi HttpOnly butuh same-origin; pastikan
  `AMA_WEB_ORIGIN` benar dan akses lewat reverse-proxy (bukan port berbeda).
- **Realtime tidak jalan** — `/socket.io` belum mem-proxy WebSocket (butuh header `Upgrade`).
- **Log** — JSON ke stdout/stderr: hanya device ID, waktu, durasi, status, kode error aman.
  Tidak ada rahasia/isi mentah. Verifikasi koleksi nyata lewat log collector, bukan fixture.

- **HTTP 500 `internal_error`** — `journalctl -u ama-server` mencatat `event:api_error` dengan
  `method`, `path`, `code`, dan `message`; query gagal dan kolom BIGINT/DECIMAL yang tidak bisa
  diserialisasi tampil di sini.
- **Alert Center kosong padahal ada gangguan** — cek `journalctl -u ama-collector | grep
  alert_eval_failed`: kode itu berarti tabel alert belum ada/korup (jalankan `npm run migrate`).
  Cek juga `ap.collector_stalled` pada halaman Alert Center: bila heartbeat collector tua,
  alert per-AP sengaja ditahan dan hanya `incident.collector` yang muncul.
- **`incident.collector` aktif bersama banyak alert per-AP** — urutannya: benahi collector dulu
  (heartbeat, koneksi DB), alert per-AP akan dievaluasi ulang setelah data segar kembali. Alert
  per-AP yang sudah terbuka **tidak** ditutup selama data tidak ada.
- **Alert berkedip tiap 15 detik** — tidak seharusnya: alert aktif hanya ditulis ulang bila
  `updated_at` sudah lebih tua dari `ALERT.touchIntervalMs` (60 s). Kalau berkedip, periksa
  ambang `min_duration_ms`/`recover_duration_ms` di `packages/shared/src/constants.js`.

## 11. Backup

Disarankan sebelum uji operasional berkelanjutan. Contoh dump harian:

```bash
sudo mysqldump --single-transaction ama_monitoring | gzip > /var/backups/ama-$(date +%F).sql.gz
```

Simpan di luar host aplikasi, batasi akses file, dan uji restore secara berkala.
Jangan campur backup dengan file `.env`/rahasia dalam satu arsip tanpa enkripsi.

Dump itu sudah mencakup tabel alert (`alerts`, `alert_events`) dan snapshot client 24 jam
terakhir (`client_observations`) karena semuanya di database yang sama — tidak ada langkah tambahan.

## 12. Keputusan deploy

Diputuskan saat deploy ke host ini (2026-10):

- **Autostart/restart** — `systemd`: `ama-server.service`, `ama-collector.service`,
  `Restart=on-failure`, `RestartSec=5`. Berjalan sebagai user pemilik repo, bukan root.
- **OS/lokasi server** — Raspberry Pi, Debian 13 arm64, `192.168.0.103`, tidak diekspos ke internet.
- **TLS** — belum. nginx listen 80 di LAN, `AMA_COOKIE_SECURE=false`. Pasang TLS sebelum
  diakses dari luar LAN.

Diputuskan saat pengelolaan perangkat dipindah ke dashboard (2026-10):

- **DB jadi sumber tunggal daftar AP** — `config/devices.json` dan `AMA_CONFIG` dihapus,
  fingerprint awal dipindah ke migrasi `003` + seed. Alasan: tambah AP butuh id otomatis
  (kunci rahasia), dan collector cukup polling 15 s sehingga tidak perlu restart.
- **Seed `INSERT IGNORE`, bukan `ON DUPLICATE KEY UPDATE`** — provision ulang tidak boleh
  menimpa perubahan yang dilakukan operator dari dashboard.
- **Rahasia tetap di berkas eksternal**, bukan DB: server menulis `/etc/ama/secrets.json`
  secara atomik (temp + rename) sebagai user layanan, sehingga tidak perlu sudo.
- **Probe fingerprint tidak auto-trust** — tombol "Uji & ambil fingerprint" + simpan manual,
  mencegah mempercayai host key secara buta.
- **Hapus perangkat ditolak bila punya histori** (`409 device_has_history`) — alternatifnya
  nonaktifkan (`enabled=0`), supaya tidak ada data monitoring hilang karena salah klik.
- **Akun aplikasi mendapat `DELETE`** (`provision-host.sh`) — dibutuhkan fitur hapus.

Diputuskan saat menambah data client Wi-Fi (2026-10; untuk AP UniFi, penundaan §1/§7 konsep-mvp dicabut atas permintaan pemilik):

- **Sumber** — `mca-dump` di AP UniFi (BZ 6.x), dibaca lewat SSH yang sama (host key diverifikasi).
  Vendor tanpa `mca-dump` → `client_count` berstatus `unsupported`, bukan nol.
- **Jumlah client disimpan** — kolom `device_metrics.client_count` (migrasi `004`), grafik
  "Client terhubung" di Detail. Hanya angka, tanpa identitas.
- **Daftar client live** — `GET /api/devices/:id/clients` SSH ke AP saat tombol ditekan dan
  **tidak disimpan** oleh endpoint itu. Sejak fitur alert, MAC client **memang** disimpan pada
  `client_observations` (MAC + AP + sinyal/trafik, **tanpa** hostname/IP) dengan retensi otomatis
  24 jam — lihat blok keputusan alert di bawah.

Diputuskan saat menambah alert proaktif & insiden (2026-10):

- **Tabel terpisah `alerts`/`alert_events`/`client_observations`** (migrasi `005`), bukan
  memakai `monitoring_events` — alur status/transisi dan realtime yang sudah jalan tidak diubah.
- **Satu baris terbuka per kondisi** — kolom `open_key` (generated, `NULL` bila `resolved`) +
  `UNIQUE`; evaluasi bersamaan dilindungi `GET_LOCK` dan tetap aman karena constraint itu.
- **Acknowledge tidak menutup alert** — hanya mencatat aktor/waktu di `alert_events`;
  penyelesaian datang dari data (auto-resolve, termasuk untuk alert yang sudah diakui) atau
  tombol selesai. Kondisi yang muncul lagi ≤30 menit membuka baris lama (`reopen_count`).
- **Hold, bukan resolve** — rule yang tidak bisa dinilai (data terlalu tua, collector mati)
  tidak menghasilkan temuan, sehingga alert terbuka tidak ditutup. "Tidak ada data" ≠ "pulih".
- **Latency = RTT ICMP collector → AP** (bukan latency client ke internet); `load` masih
  absolut karena jumlah CPU AP belum dikumpulkan.
- **Korelasi ditutup otomatis** bila tidak lagi terdeteksi pada siklus berikutnya, supaya
  insiden tidak menggantung, dan `confidence` mengikuti aturan kaku (indikator independen),
  bukan probabilitas.
- **MAC client disimpan maksimum 24 jam** (`client_observations`) hanya untuk mendeteksi
  client hilang/melemah; hostname dan IP **tidak** disimpan, dan penghapusan berjalan tiap jam
  di collector. Kebijakan privasi ini yang menggantikan "butuh kebijakan tersendiri" di atas.
- **Baris korelasi tidak menahan deteksi ulang dirinya sendiri** — skenario B (client) hanya
  menghitung alert non-client *non-korelasi* sebagai "AP punya masalah sendiri"; tanpa itu baris
  `correlation.client_issue` yang terbuka membuat korelasi ditutup lalu dibuka lagi tiap siklus.
- **`client.disconnected` hanya bila hilang dari semua AP** — hilang dari satu AP tapi ada di
  snapshot sukses *terakhir* AP lain (≤ `clientElsewhereMs` = 2 menit) = roaming: tidak membuka
  alert dan menutup yang terbuka. Sisa bolak-balik: client roaming di luar 2 menit atau selisih
  1–2 detik antar-snapshot AP; diterima, bukan dikejar. Client yang tak terlihat sepanjang
  jendela 20 menit dianggap sudah pergi → alertnya ditutup, supaya tidak menumpuk.
- **Warna sinyal client** memakai ambang rule yang sama (-70/-80 dBm dari
  `@ama/shared/constants`): hijau bagus, kuning lemah, merah sangat lemah. Kata "bagus/lemah/
  sangat lemah" selalu tampil, warna hanya penguat (aman buta warna).
- **Sudah diterapkan di host ini (2026-10-16)** — migrasi `005` dijalankan sebagai root via socket
  (`sudo mysql --protocol=socket -uroot ama_monitoring < db/migrations/005_alerts.sql`), build
  dashboard disalin ke `/srv/ama-mikrotix/apps/web/dist`, lalu `ama-server` + `ama-collector`
  di-restart. Bukti: `event:alert_eval` pada log collector dan baris pada tabel `alerts`.

Masih terbuka:

- **Retensi histori** — `client_observations` kini dihapus otomatis (24 jam). `device_metrics`,
  `monitoring_events`, `alerts`, dan `alert_events` **belum** punya penghapusan otomatis.
- **Jadwal backup & uji restore** — baru contoh manual (§11), belum dijadwalkan.
