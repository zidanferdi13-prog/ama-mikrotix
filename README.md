# Project Monitoring AP

Dashboard internal untuk memantau 3 access point (AP): keterjangkauan (ping) dan
metrik sistem (uptime, load, RAM) via SSH **read-only**. Hasil disimpan di MariaDB,
disajikan lewat Express REST + Socket.IO, dan ditampilkan di dashboard React.

Spesifikasi sumber ada di `docs/konsep-mvp.md`. Dokumen itu tidak boleh diubah.

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

## Struktur

```
apps/collector   # ping + SSH read-only, penjadwal, persist ke MariaDB
apps/server      # REST API + Socket.IO + auth JWT (HttpOnly cookie)
apps/web         # dashboard React (Vite)
packages/shared  # parser murni, konstanta, transisi, kontrak
packages/db      # pool MariaDB + helper health
db/migrations    # skema
db/seed          # inventaris 3 AP + baris heartbeat
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

   Buat akun aplikasi berhak minimum (mis. `ama_app`) dan beri akses ke `ama_monitoring`.
   Halaman CRUD perangkat sengaja tidak ada — inventaris dikelola via SQL seed.

3. **Konfigurasi**

   ```bash
   cp .env.example .env
   cp config/devices.example.json config/devices.json
   ```

   Isi `.env` (rahasia DB, `AMA_AUTH_USER`/`AMA_AUTH_PASSWORD`, `AMA_JWT_SECRET`) dan
   `config/devices.json`. Rahasia SSH **tidak** masuk `config/devices.json`; pakai
   `AMA_DEVICE_<ID>_PASSWORD` atau `AMA_SECRETS_FILE`.

   `username`, `port`, dan `hostKeyFingerprint` diisi **per AP** — bisa berbeda satu sama lain
   (mis. AP lain memakai akun sendiri, bukan `admin`).

## Menjalankan

Tiga proses terpisah:

```bash
npm run collector   # ping + SSH, menulis heartbeat
npm run server      # REST + Socket.IO di :3001
npm run web         # Vite dev server di :5173 (proxy /api & /socket.io ke :3001)
```

Buka `http://localhost:5173`, masuk dengan kredensial dari `.env`.

## Pengujian

```bash
npm test
```

Menjalankan `node --test` untuk `packages/shared/test`, `apps/collector/test`, dan `apps/server/test`.
Parser, transisi status, penjadwal, dan API diuji tanpa koneksi jaringan/SSH nyata.

## Deploy

Panduan lengkap di `docs/devops.md` (§0 jalur cepat). Ringkasnya:

```bash
npm ci && node node_modules/esbuild/install.js
npm run build -w @ama/web
cp .env.example .env                          # isi rahasia
cp config/devices.example.json config/devices.json
sudo scripts/provision-host.sh                # DB + nginx + systemd + migrasi/seed (idempoten)
curl -s localhost:3001/api/health
```

Skrip provision menyalin build dashboard ke `/srv/ama-mikrotix/apps/web/dist` (nginx tidak
bisa membaca `~` pemilik repo yang bermode 700) — jalankan ulang setelah setiap build.

## Catatan operasional

- Interval: ping 15s, sistem 60s. Kesegaran: ping >45s dan metrik >180s dianggap `stale`.
- Transisi status: `down` setelah 3 gagal beruntun, pulih setelah 2 sukses beruntun.
- Histori dibatasi maksimum 24 jam per permintaan (default 1 jam).
- Tanpa Docker/Redis/Kubernetes — satu proses per app, cocok untuk skala 3 AP.
- Data di `fixtures/` **hanya** untuk pengujian parser; jangan tampilkan sebagai data live.
- Panduan deploy, reverse-proxy, backup, dan pemecahan masalah: `docs/devops.md`.
