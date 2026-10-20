# Project Monitoring AP

Dashboard internal untuk memantau access point (AP) yang terdaftar: keterjangkauan (ping) dan
metrik sistem (uptime, load, RAM) via SSH. Koleksi tetap **read-only**; kontrol AP (saat ini
hanya **reboot**) dijalankan server atas perintah operator, lihat bagian Kontrol AP. Daftar AP dikelola dari halaman
**Perangkat** di dashboard (tabel `devices`), bukan dari berkas konfigurasi. Hasil disimpan di MariaDB,
disajikan lewat Express REST + Socket.IO, dan ditampilkan di dashboard React.

Jumlah client Wi-Fi yang terhubung ikut dikoleksi (perintah tetap `mca-dump`, hanya angkanya
yang disimpan). Daftar client (MAC/hostname/IP) hanya dibaca **live** saat diminta dari halaman
Detail dan tidak pernah masuk database.

Opsional: `AMA_ASSET_API_URL` (lihat `.env.example`) mengisi kolom **Aset** dan **Pemilik**
pada daftar client live dari `data.master_data[]`, dicocokkan lewat `mac_addr` (format `:`/`-`/`.`
dan huruf besar/kecil diabaikan). Hanya `asset_name` + `owner` yang diteruskan; kolom inventaris
lain tidak pernah dikirim ke frontend. Daftar (~200 KB) di-cache 5 menit di memori server.
Kosongkan variabel itu untuk mematikan fitur; API gagal → daftar client tetap tampil tanpa
aset/pemilik, dengan `asset_lookup_failed` + kode error di log. Alert Center memakai sumber yang
sama: `GET /api/alert-center` dan `GET /api/alerts/:id` menyertakan `assets: { "<mac>": { name, owner } }`
untuk MAC di `target`, `diagnosis.affected_clients`, dan client pada jendela insiden (`{}` bila API gagal).

Vendor, model, dan firmware AP diisi otomatis oleh collector dari laporan AP sendiri
(`mca-dump`) pada sesi SSH yang host key-nya terverifikasi; kolom `identity_verified` menandai
baris yang sudah terisi begitu. Nama AP tetap pilihan operator dan tidak pernah ditimpa.

Spesifikasi sumber ada di `docs/konsep-mvp.md`. Dokumen itu tidak boleh diubah; penambahan
kontrol AP (di luar scope §1 spesifikasi) dicatat di README ini dan `docs/devops.md` §12.

## Kontrol AP

Halaman Detail punya kartu **Kontrol AP**: reboot dengan konfirmasi mengetik nama AP persis.

- Aktif hanya bila `AMA_CONTROL_ENABLED=true` di `.env`; tanpa itu `POST /api/devices/:id/actions` → `403 control_disabled`.
- Perintah dari whitelist tetap (`reboot`), tidak pernah dari masukan pengguna. Host key wajib cocok seperti koleksi.
- Maksimal satu reboot terkirim per AP per 5 menit (`429 cooldown`).
- Setiap percobaan dicatat di tabel `device_actions` (migrasi `007`): siapa, kapan, `sent`/`failed`, kode error.
  AP yang punya riwayat aksi ikut ditolak dihapus (`409 device_has_history`).
- Efek samping wajar: alert `ap.reboot` (uptime turun) dan `ap.unreachable` sesaat selama AP boot.

## Prinsip yang dikunci

- **Tiga dimensi status terpisah**, tidak pernah digabung jadi satu warna:
  keterjangkauan (reachability), keberhasilan koleksi sistem, dan kesegaran data (freshness).
- **Gagal ≠ nol.** Nilai yang tidak valid disimpan `null`, bukan `0`.
- **`unsupported` dibedakan** dari format rusak/invalid.
- **Satu transaksi DB per siklus koleksi** (sample + status + counter + event), rollback bila gagal.
- **Socket.IO hanya emit setelah commit.** REST adalah sumber kebenaran; saat reconnect klien **wajib**
  mengambil ulang snapshot REST.
- **Heartbeat collector** untuk `/api/health`. Collector mati → data menua, bukan "semua AP down".
- **Verifikasi host key ON.** Rahasia hanya dari env/file di luar repo — tidak pernah ke Git/argv/log.
- Parser **murni** di `@ama/shared` (tanpa I/O), bisa diuji tanpa SSH.
- **Alert bukan kesimpulan tunggal.** Rule dievaluasi terpisah dari status AP; satu rule yang
  tidak dapat dinilai berarti **hold** ("tidak ada data" ≠ "pulih"), bukan resolve.
- **Kegagalan SSH tidak pernah berarti AP offline.** `ap.unreachable` hanya dari ping ICMP.
- **Acknowledge ≠ selesai.** Acknowledge mencatat siapa dan kapan; penyelesaian tetap dari data
  (auto-resolve) atau tindakan operator.
- **Rahasia SSH tidak pernah dikirim ke frontend atau log** (alert hanya membawa kode, mis. `auth_failed`).

## Struktur

```
apps/collector   # ping + SSH read-only, penjadwal, persist ke MariaDB
apps/server      # REST API + Socket.IO + auth JWT (HttpOnly cookie) + aksi kontrol AP via SSH
apps/web         # dashboard React (Vite)
packages/shared  # parser murni, konstanta, transisi, kontrak, rule alert + parser client
packages/db      # pool MariaDB + helper health
db/migrations    # skema
db/seed          # seed 3 AP awal (INSERT IGNORE) + baris heartbeat
fixtures/        # keluaran manual AP (hanya untuk uji parser)
```

## Prasyarat

- Node.js 20 (lihat `.nvmrc`) — `engines` membatasi `>=20 <21`.
- MariaDB 10.x yang bisa diakses collector dan server.

## Setup

1. **Dependensi**

   ```bash
   npm ci
   node node_modules/esbuild/install.js   # npm 11 memblokir install script paket
   ```

2. **Database**

   ```bash
   npm run migrate   # skema (db/migrations) + seed 3 AP (db/seed), idempoten
   ```

   Buat akun aplikasi berhak minimum (mis. `ama_app`; butuh `SELECT, INSERT, UPDATE, DELETE`)
   dan beri akses ke `ama_monitoring`. Seed hanya mengisi 3 AP awal; selanjutnya inventaris
   dikelola dari halaman **Perangkat** di dashboard.

3. **Konfigurasi**

   ```bash
   cp .env.example .env
   ```

   Isi `.env`: kredensial DB, `AMA_AUTH_USER`/`AMA_AUTH_PASSWORD`, `AMA_JWT_SECRET`, dan
   `AMA_SECRETS_FILE` (berkas rahasia SSH di luar repo, mode 600).

   Rahasia SSH **tidak** masuk DB/Git/argv/log. Halaman **Perangkat** menulisnya ke
   `AMA_SECRETS_FILE` dengan kunci `devices.id`; `AMA_DEVICE_<ID>_PASSWORD` tetap didukung
   sebagai alternatif untuk uji sementara.

   `username`, `port`, dan fingerprint host key diatur **per AP** pada form perangkat.
   Fingerprint diambil lewat tombol **Uji & ambil fingerprint** dan baru dipakai setelah
   disimpan; fingerprint kosong → koleksi ditolak `host_key_unpinned`.

## Menjalankan

Tiga proses terpisah:

```bash
npm run collector   # ping + SSH, menulis heartbeat
npm run server      # REST + Socket.IO di :3001
npm run web         # Vite dev server di :5173 (proxy /api & /socket.io ke :3001)
```

Buka `http://localhost:5173`, masuk dengan kredensial dari `.env`.

## Alert dan insiden

Evaluasi rule berjalan di proses collector (`apps/collector/src/alerts-job.js`) tiap **15 s**,
transaksi sendiri setelah metrik di-commit. Halaman **Alert Center** di dashboard menampilkan
ringkasan, filter (severity/status/perangkat/periode), detail bukti, dan aksi acknowledge/selesai.

- Rules: ketersediaan AP (`ap.unreachable`, `ap.flapping`, `ap.ssh.*`, `ap.metrics.stale`,
  `ap.collector_stalled`, `ap.unverified`, `ap.reboot`), performa (`ap.latency.high|critical`,
  `ap.memory.high`, `ap.load.high`, `ap.client_count.drop|spike`), uplink & radio
  (`ap.link.speed_low`, `ap.link.errors`, `ap.radio.{ng,na}.busy|interference`), kesehatan client
  (`client.signal.*`, `client.flapping`, `client.disconnected`, `client.traffic_stalled`),
  dan korelasi (`incident.ap`, `incident.shared_network`, `incident.collector`,
  `correlation.client_issue`). Semua ambang ada di `packages/shared/src/constants.js` (`ALERT`,
  `ALERT_RULES`) — nilai awal untuk kalibrasi, bukan angka final.
- Batas signifikansi yang dipakai: satu paket ICMP hilang bukan offline (butuh 3 sampel terakhir
  gagal beruntun), satu snapshot client hilang bukan disconnect (butuh 2 snapshot sukses beruntun),
  dan latency bercokol baru menjadi alert setelah 2–3 menit (masing-masing rule punya
  `min_duration_ms`/`recover_duration_ms`).
- Latency di sini adalah **RTT ICMP collector → AP**, bukan latency client ke gateway/internet.
- Siklus hidup: `active` → `acknowledged` → `resolved`. Acknowledge dicatat pada `alert_events`
  (aktor + waktu) dan **tidak** menutup alert; rule yang pulih menutupnya otomatis, termasuk yang
  sudah diakui. Kondisi yang muncul lagi dalam 30 menit membuka ulang baris yang sama
  (`reopen_count` naik), bukan membuat alert baru.
- Korelasi A–D (`incident.*`, `correlation.client_issue`) merangkum beberapa rule dengan
  `confidence` low/medium/high, bukti yang ada dan yang **tidak** ada, perangkat/klien terdampak,
  serta langkah berikut. Korelasi yang tidak lagi terdeteksi ditutup otomatis pada siklus
  berikutnya — tidak menggantung.
- Saat collector bermasalah (`incident.collector` aktif), alert per-AP ditahan: bukan bukti AP
  mati. Alert per-AP yang sudah terbuka juga tidak ditutup selama data tidak tersedia.

## Pengujian

```bash
npm test
```

Menjalankan `node --test` (penemuan otomatis berkas `*.test.js` di `packages/shared/test`,
`apps/collector/test`, dan `apps/server/test`).
Parser, transisi status, penjadwal, API, dan rule alert diuji tanpa koneksi jaringan/SSH nyata.

## Deploy

Panduan lengkap di `docs/devops.md` (§0 jalur cepat). Ringkasnya:

```bash
npm ci && node node_modules/esbuild/install.js
npm run build -w @ama/web
cp .env.example .env                          # isi rahasia
sudo scripts/provision-host.sh                # DB + nginx + systemd + migrasi/seed (idempoten)
sudo systemctl restart ama-server ama-collector   # unit memuat .env saat start
curl -s localhost:3001/api/health
```

Skrip provision menyalin build dashboard ke `/srv/ama-mikrotix/apps/web/dist` (nginx tidak
bisa membaca `~` pemilik repo yang bermode 700) — jalankan ulang setelah setiap build.

## Catatan operasional

- Interval: ping 15s, sistem 60s. Kesegaran: ping >45s dan metrik >180s dianggap `stale`.
- Daftar AP disegarkan collector tiap 15 s dari tabel `devices`: tambah, nonaktifkan, dan
  hapus dari dashboard berlaku tanpa restart collector.
- Transisi status: `down` setelah 3 gagal beruntun, pulih setelah 2 sukses beruntun.
- Histori dibatasi maksimum 24 jam per permintaan (default 1 jam).
- Alert dievaluasi collector tiap 15 s. Migrasi `005_alerts.sql` menambah tabel `alerts`,
  `alert_events`, `client_observations` — jalankan `npm run migrate` sebelum restart proses.
- Migrasi `006_link_radio.sql` menambah kolom link ethernet (`eth_*`) dan radio per band
  (`radio_{ng,na}_*`) pada `device_metrics`, dari `mca-dump` yang sudah diambil (tanpa perintah
  SSH baru). Butuh hak DDL (root) — jalankan sebelum restart collector, karena INSERT metrik
  sistem memakai kolom baru. `rx_dropped` hanya ditampilkan, tidak dijadikan alert.
- `client_observations` (hanya MAC + AP, tanpa hostname/IP) disimpan 24 jam lalu dihapus otomatis.
- Tanpa Docker/Redis/Kubernetes — satu proses per app, cocok untuk skala 3 AP.
- Data di `fixtures/` **hanya** untuk pengujian parser; jangan tampilkan sebagai data live.
- Panduan deploy, reverse-proxy, backup, dan pemecahan masalah: `docs/devops.md`.
