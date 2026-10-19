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
server     ──(SSH aksi: reboot)──────► AP (host key diverifikasi, perintah whitelist)
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

Migrasi `007_device_actions.sql` (aditif, idempoten) menambah tabel audit `device_actions` untuk
aksi kontrol AP (§12). Terapkan **sebelum** me-restart `ama-server`; bila belum diterapkan,
riwayat/reboot dari dashboard **dan** hapus perangkat gagal `500` (SSH tidak pernah dibuka) —
koleksi monitoring tidak terpengaruh.

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
- `AMA_CONTROL_ENABLED` (default `false`) — `true` mengaktifkan aksi kontrol AP (`reboot`) dari
  halaman Detail; lihat §12.

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

Firewall host (`ufw`, default menolak masuk) membuka port 80 untuk semua sumber:
`sudo ufw allow 80/tcp`. Keputusan 2026-10-19: host hanya ada di WiFi internal, jadi yang bisa
menjangkau hanya perangkat satu segmen (plus peer Tailscale). Dashboard tanpa TLS: jangan
forward port 80 dari router ke internet.
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

Backup berjalan otomatis: `ama-backup.timer` memicu `ama-backup.service` setiap hari 02:30 waktu
lokal (`Persistent=true`, jadi jadwal yang terlewat saat host mati ikut dijalankan), dan menyimpan
7 dump terakhir.

- Lokasi `/var/backups/ama/ama-YYYY-MM-DD.sql.gz`: direktori `700`, file `600`, milik root.
- Isi: seluruh database `ama_monitoring` lewat `mariadb-dump --single-transaction --routines`,
  jadi tulis baca tetap jalan dan tabel `alerts`, `alert_events`, serta snapshot client
  (`client_observations`) ikut tanpa langkah tambahan.
- Tanpa password di file: unit berjalan sebagai root dan memakai socket Unix MariaDB.
- Dump ditulis ke `.part` lalu di-rename, jadi dump yang gagal tidak tampak seperti backup sah.
- Cek: `systemctl list-timers ama-backup.timer`, `journalctl -u ama-backup.service`,
  `sudo gzip -t /var/backups/ama/*.sql.gz`.

Uji restore — sudah dijalankan 2026-10-16 pada host ini; jumlah baris `devices`, `alerts`,
`alert_events`, dan `alerts` yang masih terbuka cocok dengan produksi:

```bash
sudo mysql --protocol=socket -uroot -e "CREATE DATABASE ama_restore_test"
sudo zcat /var/backups/ama/ama-<tanggal>.sql.gz | sudo mysql --protocol=socket -uroot ama_restore_test
sudo mysql --protocol=socket -uroot -e "SELECT COUNT(*) FROM ama_restore_test.alerts"
sudo mysql --protocol=socket -uroot -e "DROP DATABASE ama_restore_test"
```

Yang belum ada: salinan di luar host ini (dump masih satu disk dengan database), dan uji restore
belum dijadwalkan berkala. Batasi akses file, dan jangan campur backup dengan `.env`/rahasia dalam
satu arsip tanpa enkripsi.

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
- **Retensi otomatis** (tiap jam di collector, `ALERT.retentionMs`): `client_observations` 24 jam,
  `device_metrics` 30 hari (riwayat API maksimum 24 jam), `alerts` yang `resolved` 90 hari sejak
  `resolved_at` — `alert_events`-nya ikut terhapus lewat `ON DELETE CASCADE`. Alert terbuka tidak
  pernah dihapus. Kegagalan prune hanya log `prune_failed`, evaluasi tetap jalan.
- **Sudah diterapkan di host ini (2026-10-16)** — migrasi `005` dijalankan sebagai root via socket
  (`sudo mysql --protocol=socket -uroot ama_monitoring < db/migrations/005_alerts.sql`), build
  dashboard disalin ke `/srv/ama-mikrotix/apps/web/dist`, lalu `ama-server` + `ama-collector`
  di-restart. Bukti: `event:alert_eval` pada log collector dan baris pada tabel `alerts`.
- **Kalibrasi alert (2026-10-16)** — `incident.ap` sempat aktif di 7 AP sekaligus karena baris
  `resolved` (dimuat collector hanya untuk *reopen*) ikut dihitung sebagai alert terbuka oleh rule
  dan korelasi. Kini korelasi hanya melihat alert yang belum `resolved` dan tidak sedang ditutup
  siklus itu (`correlationInputOf`). Selain itu:
  - `client.disconnected` (churn: client pulang ≠ client rusak) **bukan** gejala insiden — tidak
    mengangkat `incident.ap` maupun `correlation.client_issue`, hanya dihitung `disappeared`.
  - `ap.client_count.*` keluar dari indikator `resources`: diturunkan dari daftar client yang
    sama dengan indikator `clients`, jadi dulu skornya ganda.
  - `clientTrafficStalled.snapshots` 3 → 5 (replay histori: episode counter-diam-sinyal-lemah
    404 → 163); `clientCount.minBaseline` 4 → 6 (episode drop sehari 16 → 10). Ambang sinyal dan
    `clientGoneSnapshots` tidak diubah — lonjakan sebelumnya sudah ditutup perbaikan `93fb333`/
    `8c9e30b`.
- **Identitas AP otomatis dari `mca-dump`** — collector membaca `model_display` (fallback
  `model`) dan `version` dari output `mca-dump` yang sudah diambil tiap siklus sistem, lalu
  menulis `vendor='Ubiquiti'`, `model`, `firmware`, `identity_verified=1` (hanya bila berubah;
  log `identity_verified`). Sah karena datang dari sesi SSH dengan host key ter-pin. `info` tidak
  dipakai: builtin shell, `ash: info: not found` lewat exec. `name` tidak pernah ditimpa (nama
  pilihan operator). Vendor tanpa `mca-dump` tetap `identity_verified=0` dan diisi manual.

Diputuskan saat menambah kesehatan link ethernet & radio (2026-10-16):

- **Sumber tetap `mca-dump`** — `if_table[0]` (uplink ethernet) dan `radio_table[].athstats`
  (per band) dibaca dari output yang **sudah** diambil tiap siklus sistem. Tidak ada perintah SSH
  baru, tidak ada sesi tambahan ke AP. Channel diambil dari `vap_table` (VAP `vwire*` = mesh
  internal, dilewati). Kolom `device_metrics` baru: migrasi `006`.
- **Nilai tak terukur = `NULL`, tidak pernah `0`** — `speed` 0 (link nonaktif), `cu_*` di luar
  0–100, counter negatif/bukan angka, dan `noise_floor` di luar −120…−50 dBm semuanya jadi
  `NULL`. Firmware 4.3.31 (dev 8) melaporkan `noise_floor` 2,4 GHz sebagai sampah
  (mis. −2078592224) → tidak disimpan, bukan diartikan sebagai noise sangat rendah
  (`ponytail:` di `parser.js`, perluas bila ada radio dengan rentang lain).
- **`link`/`radio` di `metric_status` tidak memengaruhi `collection_status`** — sama seperti
  `client_count`: AP non-UniFi berstatus `unsupported` (bukan error) dan itu tidak boleh
  menurunkan sampel uptime/load/RAM yang sehat menjadi `partial`.
- **Rule baru** — `ap.link.speed_low` (warning, `eth_speed_mbps` < 1000 selama 5 menit),
  `ap.link.errors` (warning, counter `rx_errors+tx_errors` naik pada ≥2 interval sampel dalam
  jendela 20 menit; turun = counter reset saat reboot → diabaikan), `ap.radio.{ng,na}.busy`
  (warning, channel utilisation > 70 % selama 10 menit), `ap.radio.{ng,na}.interference`
  (info, `cu_interf` > 30 % selama 10 menit). Ambang 1000 Mbps karena semua AP saat ini
  (UAP-AC-LR/Lite/Pro) ber-port gigabit; dev 12 (UAP-AC-Pro-Gen2) hanya menegosiasi 100 FD →
  temuan nyata di sisi kabel/port. `ap.radio.*` masuk indikator `ap_resources` korelasi (bukan
  indikator baru): radio padat bisa berasal dari AP tetangga, tapi tetap alasan AP perlu dilihat.
- **`rx_dropped`/`tx_dropped` tidak dinilai, hanya ditampilkan** — pada AP berbasis Linux counter
  itu ikut menghitung frame VLAN/protokol tak dikenal. Kalibrasi 2026-10-16: dev 8 menambah
  ~14 drop/menit sementara `rx_errors`/`tx_errors` tetap 0 di 9 AP — akan jadi alert palsu terus
  menerus. Tampil di kartu Detail sebagai konteks saat link bermasalah.
- **Kalibrasi 2026-10-16 (data live, 9 AP)** — `eth_speed_mbps` 1000 (dev 12 = 100),
  `rx/tx_errors` 0 semua, channel utilisation maksimum 39 % (ng dev 2), `cu_interf` `NULL` di
  dev 2/7/8/12, `noise_floor` ng `NULL` semua dan na ≈ −95 dBm. Ambang rule diletakkan jauh di
  atas nilai normal ini supaya tidak menyala karena fluktuasi biasa; `cu_interf` `NULL` membuat
  rule interferensi tidak dinilai (hold), bukan tutup.
- **Penerapan di host ini** — migrasi `006` dijalankan sebagai root via socket
  (`sudo mysql --protocol=socket -uroot ama_monitoring < db/migrations/006_link_radio.sql`)
  **sebelum** collector di-restart, karena `INSERT` metrik sistem memakai kolom baru. Setelah itu
  `ama-collector` + `ama-server` di-restart dan dashboard di-build ulang lalu disalin ke
  `/srv/ama-mikrotix/apps/web/dist`.

Diputuskan saat menambah kontrol AP / reboot dari dashboard (2026-10-19, atas permintaan pemilik —
penundaan §1 konsep-mvp "tidak ada reboot" dicabut untuk aksi `reboot` saja):

- **Dijalankan server, bukan collector** — collector tetap read-only supaya siklus koleksi tidak
  bergantung pada aksi operator. `apps/server/src/ssh-action.js` memakai pola sesaat yang sama
  dengan `ssh-clients.js`: host key wajib cocok, rahasia hanya di memori, `conn.end()` +
  `conn.destroy()` selalu dipanggil.
- **Perintah dari whitelist tetap** — `ACTIONS = { reboot: 'reboot' }`; nama aksi tidak dikenal →
  `400 invalid_payload`. Tidak ada string dari masukan pengguna yang masuk ke `exec`.
- **Konfirmasi mengetik nama AP** — body wajib memuat `confirm` yang sama persis dengan
  `devices.name`; salah → `400` dengan `fields.confirm = confirm_mismatch`. Tombol UI nonaktif
  sampai cocok.
- **Gate `AMA_CONTROL_ENABLED`** — tanpa `true`, endpoint mengembalikan `403 control_disabled`.
  `GET /api/devices/:id/actions` melaporkan `control_enabled` supaya UI menyembunyikan tombol.
  ponytail: masih satu akun operator tanpa role per aksi; tambahkan daftar pengguna + role bila
  dashboard dipakai banyak orang.
- **Cooldown 5 menit per AP** — dihitung dari aksi `sent` terakhir; pelanggaran → `429 cooldown`
  + `next_allowed_at`. Percobaan gagal tidak mengunci.
- **Status `sent`, bukan "AP sudah reboot"** — reboot memutus sesi SSH; perintah dianggap terkirim
  bila `exec` diterima dan tidak ada exit status non-nol (non-nol → `exec_failed`). Bukti AP
  benar-benar restart datang dari data: rule `ap.reboot` (uptime turun) dan `ap.unreachable`
  sesaat. Kode gagal lain: `host_key_unpinned`, `host_key_changed`, `auth_failed`,
  `connect_failed`, `timeout`.
- **Audit `device_actions` (migrasi `007`)** — satu baris per percobaan yang mencapai SSH
  (sukses maupun gagal): `requested_by`, `requested_at`, `status`, `error_code`, plus log
  `device_action`. `deviceHasHistory` ikut menghitung tabel ini, jadi AP dengan riwayat aksi
  tidak bisa dihapus. Tanpa retensi otomatis — audit sengaja disimpan.
- **Efek samping yang wajar** — collector membuat alert `ap.reboot` (info) dan mungkin
  `ap.unreachable` selama AP boot (±1–3 menit).

Masih terbuka:

- **Retensi `monitoring_events`** — belum dihapus otomatis (baris sedikit: hanya transisi status).
- **Backup di luar host & uji restore berkala** — dump harian sudah terjadwal (§11), tapi masih
  tersimpan di disk yang sama dan belum ada jadwal uji restore.
