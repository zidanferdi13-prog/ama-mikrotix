# Konsep MVP — Project Monitoring AP

Tanggal: 15 Oktober 2026  
Versi: 0.1 — draft untuk review Zidan  
Direktori: `D:\Kerjaan\Project\ama-mikrotik`  
Pemilik keputusan scope: Zidan  
Koordinasi: Project Lead; pengembangan: Web Developer; pengujian: QA Reviewer

> Dokumen konsep, bukan laporan aplikasi selesai. Implementasi collector, database, API, dan dashboard belum diverifikasi. Angka jadwal polling dan ambang status di bawah merupakan usulan, bukan keputusan final.

## 1. Tujuan dan batas MVP

Dashboard internal menampilkan keterjangkauan tiga AP, latency, uptime, RAM, load average, histori metrik, dan event perubahan status. Seluruh data operasional harus berasal dari pengukuran nyata; data contoh hanya untuk pengujian dan tidak boleh tampil sebagai data live.

Keputusan yang sudah mendapat persetujuan dalam room:
- Uji awal dibatasi pada tiga AP.
- Jalur awal ping dan SSH read-only; collector mengikuti vendor/OS yang terverifikasi.
- Penyesuaian dari asumsi MikroTik diperlukan karena APOfficeLT1 teridentifikasi sebagai UniFi.

Acuan teknis awal yang dipertahankan dalam rancangan:
- Node.js LTS, Express, `ssh2`, MariaDB, React, dan Socket.IO.
- Satu server dapat menjalankan collector dan backend; tidak perlu Docker, Redis, atau Kubernetes.
- Tidak mengganti runtime global. Versi Node.js LTS khusus proyek perlu ditetapkan sebelum implementasi.

Tidak termasuk MVP awal:
- Perubahan konfigurasi AP, reboot, upgrade firmware, atau kontrol firewall.
- Integrasi UniFi Controller, RouterOS API, dan SNMP.
- Data client Wi-Fi, SSID/signal, serta grafik trafik RX/TX sebelum sumber dan izin aksesnya tervalidasi.
- Persentase CPU; yang tersedia saat ini adalah load average.
- Penemuan perangkat otomatis, halaman CRUD inventaris, multi-tenant, atau pengelolaan pengguna kompleks.
- Notifikasi WhatsApp/email/Telegram, laporan terjadwal, dan ekspansi seluruh AP.

Penambahan fitur tersebut memerlukan keputusan scope terpisah, bukan otomatis ikut karena tersedia pada perangkat.

## 2. Fakta dan bukti saat ini

### 2.1 Inventaris awal

| Nama | IP management | Identitas terverifikasi | Status bukti SSH |
|---|---|---|---|
| APOfficeLT1 | `192.168.5.228` | Ubiquiti UniFi `UAP-AC-LR`, firmware `6.8.2.15592` | Zidan berhasil menjalankan `info`, `uptime`, `free`, dan pembacaan `/proc` secara manual |
| APOfficeLT2 | `192.168.5.226` | Vendor, model, dan firmware belum terverifikasi | TCP/22 terjangkau; login dan sumber metrik belum terverifikasi |
| APNUSANTARA | `192.168.5.120` | Vendor, model, dan firmware belum terverifikasi | TCP/22 terjangkau; login dan sumber metrik belum terverifikasi |

Uji jaringan terakhir yang dilaporkan Project Lead, 15 Oktober 2026 sekitar 15:32 WIB, berasal dari `AMA-ICT-N04` (`192.168.5.232`): ketiganya membalas 2/2 ping tanpa loss dan TCP/22 terhubung. Ini snapshot keterjangkauan dari mesin tersebut, bukan bukti akses dari server production atau monitoring berkelanjutan.

Akun yang disebut untuk APOfficeLT1: `admin`, autentikasi password. Percobaan SSH noninteraktif tanpa password ditolak; belum ada bukti collector berhasil autentikasi otomatis. Akun monitoring berhak minimum lebih tepat untuk operasional, tetapi pembuatan/perubahan akun AP memerlukan izin terpisah.

### 2.2 Sumber metrik APOfficeLT1 yang sudah dibaca manual

Cuplikan asli dari pesan Zidan:

```text
/proc/uptime:
266591.49 230845.51

/proc/loadavg:
0.10 0.11 0.09 3/58 7994

/proc/meminfo, field terkait:
MemTotal:         125580 kB
MemFree:           44500 kB
MemAvailable:      67068 kB
```

Interpretasi:
- Uptime memakai field pertama: `266591.49` detik, sekitar 3 hari 2 jam 3 menit 11 detik.
- Tiga field pertama load average adalah beban 1, 5, dan 15 menit: `0.10`, `0.11`, `0.09`; bukan persen CPU.
- Field kedua `/proc/uptime` tidak dipakai sebagai persentase CPU.
- `kB` pada `/proc/meminfo` dikonversi sebagai KiB, yaitu dikali 1024 untuk byte.
- Estimasi RAM terpakai = `MemTotal - MemAvailable` = `58512 KiB` = `59916288` byte.
- Estimasi persen RAM terpakai = `(125580 - 67068) / 125580 * 100` = sekitar `46.6%`.
- Jangan menggunakan `MemTotal - MemFree` sebagai pengganti diam-diam; maknanya berbeda.

Hitungan sampel telah diperiksa QA; parser implementasi belum diuji. Sampel manual tidak memiliki timestamp koleksi otomatis. Jangan mengarang waktu pengukuran untuk fixture ini.

### 2.3 Asumsi yang tidak boleh dibuat

- Banner Dropbear tidak membuktikan model atau OS AP lain.
- `http://192.168.5.26:8080/inform` yang muncul pada output `info` menunjukkan alamat inform perangkat; bukan endpoint API monitoring yang sudah tervalidasi.
- Keberhasilan perintah dalam shell interaktif tidak otomatis membuktikan perintah sama tersedia melalui SSH exec noninteraktif.
- Repo diperiksa saat penyusunan dokumen: branch `main`, belum ada commit atau file aplikasi. Pemeriksaan ini tidak menyatakan pekerjaan paralel tim sesudahnya sudah selesai.

## 3. Alur dari AP sampai dashboard

```text
Tiga AP yang terdaftar
  | ping; SSH perintah baca yang ditetapkan
  v
Collector Node.js
  scheduler, batas concurrency, timeout, parser, validasi
  |
  v
MariaDB
  inventaris, sampel, status terakhir, event
  |
  v
Express REST + Socket.IO
  autentikasi, validasi parameter, pembatasan rentang histori
  |
  v
React Dashboard
  ringkasan AP, detail, grafik, event, indikator data lama
```

Urutan kerja satu sampel:
1. Scheduler memilih pekerjaan yang jatuh tempo; jangan memulai pekerjaan kedua untuk AP dan jenis koleksi yang masih aktif.
2. Ping mengukur keterjangkauan dan latency. SSH mengambil metrik sistem melalui daftar perintah baca tetap.
3. Parser mengubah keluaran menjadi field numerik tervalidasi, disertai status setiap metrik.
4. Backend menyiapkan hasil, waktu koleksi, serta error yang sudah disanitasi. Kegagalan tidak diubah menjadi angka nol.
5. Dalam satu transaksi database, simpan sampel, status, penghitung transisi, dan event yang memenuhi aturan; rollback bila transaksi gagal.
6. Socket.IO mengirim pemberitahuan perubahan hanya setelah commit berhasil. Browser mengambil keadaan terbaru melalui REST.
7. Dashboard memperbarui nilai dan grafik; timestamp dan kesegaran data tetap terlihat.

REST menjadi sumber kebenaran saat halaman dibuka dan setelah Socket.IO reconnect. Pesan realtime yang terlewat tidak boleh menyebabkan UI mempertahankan status lama tanpa sinkronisasi ulang.

## 4. Collector dan kontrak data

### 4.1 Koleksi terpisah

| Jenis | Sumber | Nilai utama | Batasan |
|---|---|---|---|
| Ping | ICMP dari mesin collector | Respons, latency, waktu pemeriksaan | Gagal ping berarti tidak terjangkau dari collector; belum membuktikan AP mati secara fisik |
| Sistem | SSH read-only | Uptime, load 1/5/15 menit, RAM | Gagal autentikasi/SSH tidak otomatis menjadikan AP down |
| Identitas | `info` bila tersedia melalui SSH exec | Nama, model, firmware | Validasi saat onboarding; jangan mengasumsikan sintaks RouterOS |

Perintah sistem awal yang sudah dibaca manual pada APOfficeLT1:

```sh
cat /proc/uptime
cat /proc/loadavg
cat /proc/meminfo
```

Collector memakai perintah konstan, bukan perintah dari request pengguna. Jangan memakai shell output prompt sebagai bagian data. Metode pengambilan identitas harus diuji tersendiri karena `info` dapat bergantung pada lingkungan shell.

### 4.2 Usulan jadwal, belum disetujui

| Parameter | Usulan awal |
|---|---|
| Interval ping | 15 detik per AP |
| Interval SSH sistem | 60 detik per AP |
| Concurrency ping | Maksimum 2 AP |
| Concurrency SSH | Maksimum 2 koneksi |
| Timeout ping | 2 detik per pemeriksaan |
| Timeout koneksi SSH | 5 detik |
| Timeout satu perintah SSH | 5 detik, dengan batas total sesi 15 detik |
| Retry | Tidak melakukan retry langsung; coba pada jadwal berikutnya |
| Ping stale | Lebih dari 45 detik tanpa hasil pemeriksaan baru |
| Metrik sistem stale | Per metrik: lebih dari 180 detik sejak observasi valid terakhir metrik tersebut |

Bila siklus belum selesai, lewati slot berikutnya untuk pekerjaan yang sama; jangan menumpuk antrean tanpa batas. Tutup koneksi ketika sukses, gagal, atau timeout. Kegagalan satu AP tidak membatalkan pekerjaan AP lain.

Nilai ini titik awal untuk uji tiga AP, bukan target performa production yang sudah dibuktikan.

### 4.3 Field hasil normalisasi

| Field | Makna |
|---|---|
| `device_id` | ID internal stabil; bukan IP sebagai identitas permanen |
| `kind` | `ping` atau `system` |
| `observed_at` | Waktu observasi oleh collector, disimpan UTC |
| `received_at` | Waktu hasil diterima/disimpan server |
| `collection_status` | `ok`, `partial`, atau `error` |
| `metric_status` | Status dan kode error per field; `unsupported` dibedakan dari format rusak |
| `reachable` | Boolean untuk hasil ping yang selesai; `null` bila pemeriksaan sendiri tidak dapat dijalankan |
| `latency_ms` | Latency nonnegatif saat mendapat balasan; selain itu `null` |
| `uptime_seconds` | Field pertama `/proc/uptime`, numerik nonnegatif |
| `load_1`, `load_5`, `load_15` | Load average nonnegatif; tanpa simbol persen |
| `memory_total_bytes` | `MemTotal * 1024`, positif |
| `memory_available_bytes` | `MemAvailable * 1024`, rentang 0 sampai total |
| `memory_used_bytes` | Total dikurangi available |
| `memory_used_percent` | Used dibagi total dikali 100 |

Field yang tidak berlaku pada jenis sampel tidak dianggap error: sampel ping tidak harus memiliki RAM. Timestamp observasi valid terakhir dipertahankan **per metrik**, terpisah dari timestamp percobaan terbaru. Sampel `partial` dengan load valid tetapi RAM gagal hanya memperbarui timestamp load; nilai dan timestamp valid terakhir RAM tidak berubah. Respons nilai terakhir menyertakan `last_valid_at` per metrik, atau `null` bila belum pernah valid. Timestamp baru pada metrik lain tidak menyegarkan data lama.

Aturan parser:
- Field hilang, format rusak, `NaN`, atau nilai tak hingga menghasilkan `null` dan error pada metrik terkait.
- `MemTotal <= 0` tidak valid; `MemAvailable=0` valid dan berarti estimasi RAM terpakai 100%.
- `MemAvailable` di luar `0..MemTotal` tidak valid; total yang masih valid boleh dipertahankan.
- Kerusakan satu metrik tidak menghapus metrik lain yang valid.
- Bila `MemAvailable` tidak didukung AP lain, tandai metrik turunannya `unsupported`; jangan mengganti rumus tanpa persetujuan.
- Pembulatan dilakukan saat tampilan; simpan presisi sumber yang diperlukan.

## 5. Status, kesegaran, dan event

Jangan gabungkan tiga dimensi berikut menjadi satu warna:

| Dimensi | Pilihan tampilan | Aturan |
|---|---|---|
| Keterjangkauan | Belum diketahui / Terjangkau / Tidak terjangkau | Berdasarkan hasil ping dan ambang transisi |
| Koleksi sistem | Normal / Sebagian gagal / Gagal / Belum diuji | Berdasarkan SSH dan validasi metrik |
| Kesegaran | Segar / Data lama / Belum ada data | Berdasarkan timestamp observasi valid setiap metrik, bukan timestamp sampel atau kelompok terbaru |

Contoh: ping berhasil tetapi SSH salah password ditampilkan sebagai **Terjangkau — pengambilan metrik gagal**, bukan AP down. Nilai RAM terakhir tetap membawa waktu observasi aslinya, menjadi **Data lama** setelah melewati ambang stale; error koleksi terbaru terlihat segera. Titik grafik baru tidak boleh dibuat dari nilai lama. RAM juga tetap menua ketika load pada sampel berikutnya berhasil tetapi RAM gagal.

Usulan kebijakan event, masih menunggu persetujuan Zidan:
- Dari kondisi unknown, hasil ping pertama yang sukses menetapkan reachable tanpa event recovery palsu.
- Tiga pemeriksaan ping gagal beruntun menetapkan tidak terjangkau.
- Dua pemeriksaan ping sukses beruntun setelah kondisi tidak terjangkau menetapkan recovery.
- Hanya pemeriksaan yang benar-benar dijalankan dihitung. Collector berhenti atau error internal tidak menambah hitungan gagal ping AP.
- Satu transisi menghasilkan satu event; pemeriksaan berulang pada keadaan sama tidak membuat alarm duplikat.
- Simpan keadaan dan penghitung yang dibutuhkan agar restart backend tidak menghasilkan transisi palsu.
- Threshold alarm RAM/load belum dipilih. Persentase CPU belum tersedia; jangan membuat alarm CPU dari load average.

Jika collector berhenti, API dan dashboard harus menunjukkan collector tidak sehat serta data stale. Jangan mengubah seluruh AP menjadi down karena server monitoring bermasalah.

## 6. Penyimpanan minimum

Tiga tabel cukup untuk scope awal; belum perlu membuat `wifi_clients` karena datanya belum tervalidasi.

| Tabel | Isi minimum |
|---|---|
| `devices` | ID, nama, IP, vendor/model/firmware bila diketahui, referensi akses tanpa rahasia, status terakhir, timestamp kesuksesan, keadaan transisi |
| `device_metrics` | Device ID, jenis koleksi, timestamp UTC, nilai nullable, status/error per metrik |
| `monitoring_events` | Device ID, jenis event, waktu mulai/perubahan/selesai, status aktif/selesai, detail yang disanitasi |

- Inventaris tiga AP diisi melalui seed/config terkontrol; belum ada halaman tambah/hapus perangkat.
- Indeks utama histori: `(device_id, kind, observed_at)`; event diindeks berdasarkan perangkat dan waktu.
- Jangan menyimpan password SSH atau dump lingkungan proses dalam tabel maupun log.
- Gagal DB tidak boleh diikuti event realtime yang mengaku data sudah tersimpan. Tandai health gagal dan log error aman; MVP tidak menambah antrean persisten lain.
- Retensi data dan backup perlu ditentukan sebelum uji operasional berkelanjutan. Penghapusan data otomatis tidak diaktifkan tanpa persetujuan retensi.
- Sampel grafik yang gagal menjadi gap/null, bukan nol dan bukan interpolasi diam-diam.

## 7. API dan realtime

Semua endpoint operasional dan Socket.IO memerlukan autentikasi. Mekanisme login final perlu ditentukan sebelum tahap API, bukan ditunda sampai sesudah dashboard dipakai.

| Endpoint | Kegunaan |
|---|---|
| `GET /api/devices` | Ringkasan tiga AP, status tiap dimensi, nilai dan timestamp terakhir |
| `GET /api/devices/:id` | Identitas, status rinci, koleksi terakhir, error aman |
| `GET /api/devices/:id/metrics?from=...&to=...` | Histori dengan rentang waktu tervalidasi |
| `GET /api/alerts` | Event status dan alarm aktif/selesai sesuai kebijakan yang disetujui |
| `GET /api/health` | Kesehatan backend, DB, dan heartbeat collector |

`GET /api/devices/:id/clients` ditunda; jangan mengembalikan array contoh seolah sumber client sudah berhasil dipantau.

Ketentuan:
- ID tidak ditemukan menghasilkan 404; parameter/rentang salah menghasilkan 400; tanpa autentikasi menghasilkan 401.
- Usulan batas awal histori: default 1 jam, maksimum 24 jam per request; pagination event dan batas jumlah titik ditetapkan sebelum rilis.
- Query memakai parameter, bukan penyambungan string masukan.
- Respons membedakan error, belum ada data, dan nilai nol yang sah. Setiap nilai terakhir memiliki `last_valid_at` dan indikator kesegaran sendiri; sampel `partial` tidak mengubah timestamp metrik yang gagal.
- REST dan Socket.IO menggunakan aturan akses sama, dengan origin dibatasi.
- Payload dan log tidak memuat password, private key, token, atau isi konfigurasi rahasia.
- Event awal: `device.status.changed`, `metrics.updated`, `alert.created`; identitas perangkat dan timestamp membantu browser mengambil ulang data.
- Jika Socket.IO terputus, tampilkan indikator koneksi; reconnect wajib mengambil snapshot REST baru.

## 8. Konsep dashboard

Dashboard read-only. Fokus: operator cepat mengetahui AP mana yang tidak terjangkau, kapan data terakhir diperoleh, dan apakah masalah berasal dari AP atau collector.

### 8.1 Layar login

- Akses operasional melalui autentikasi; tidak ada registrasi publik dalam MVP.
- Pesan gagal login tidak membocorkan rincian kredensial.
- Logout dan sesi kedaluwarsa menghentikan akses REST maupun realtime.

### 8.2 Ringkasan AP

```text
Project Monitoring AP                  Collector: [status] [Logout]
Pembaruan terakhir: [waktu]             Realtime: [status]

[Total AP] [Terjangkau] [Tidak terjangkau] [Belum diketahui]

Cari nama/IP                 Filter keterjangkauan dan data lama

Nama | IP | Keterjangkauan | Koleksi sistem | Latency | RAM | Data terakhir
APOfficeLT1  ...
APOfficeLT2  ...
APNUSANTARA ...

Event terbaru: waktu | AP | jenis | status
```

- Angka ringkasan harus berasal dari AP yang benar-benar terdaftar.
- Load average bisa ditampilkan sebagai tiga angka atau pada detail; jangan dinamai CPU %.
- Label teks/ikon mendampingi warna status.
- Klik AP membuka detail; filter tidak menghilangkan status error collector dari layar.

### 8.3 Detail AP

- Identitas: nama, IP, vendor/model, firmware; nilai belum diketahui dilabeli jelas.
- Kartu: keterjangkauan, latency, uptime, RAM, load 1/5/15 menit, status koleksi.
- Waktu percobaan terakhir dan waktu observasi valid terakhir per metrik ditampilkan terpisah; RAM lama tidak mengikuti timestamp load yang baru.
- Grafik histori: latency, RAM %, dan load average dengan satuan serta sumbu terpisah.
- Pilihan rentang awal: 1 jam dan 24 jam, mengikuti batas API.
- Tabel event perangkat dan pesan error terkontrol, bukan keluaran mentah SSH.

### 8.4 Keadaan UI wajib

- Loading, inventaris kosong, belum ada sampel, error API/DB, tidak terautentikasi, dan realtime terputus.
- Data stale tetap dikenali tanpa bergantung warna; nilai tidak tersedia menggunakan `—`, bukan `0`.
- Grafik tidak menutupi gap kegagalan atau menyambungkan nilai lama seolah sampel baru.
- Timestamp disimpan UTC, ditampilkan WIB (`Asia/Jakarta`) dengan label zona waktu.
- Tata letak responsif, tabel bisa dibaca di mobile, navigasi keyboard dan fokus terlihat, label input serta grafik dapat diakses.
- Branding, logo, dan palet belum disepakati; rancangan awal utilitarian, bukan desain merek final.

## 9. Keamanan dan operasi

1. Masukkan password langsung melalui terminal lokal/prompt tersamarkan atau mekanisme secret server yang disepakati. Jangan kirim password/private key ke chat, argumen command line, log, atau Git.
2. Mekanisme password otomatis belum tersedia. Pilih secret store OS atau konfigurasi runtime/service berizin terbatas setelah OS server ditentukan. Jika memakai file lokal, letakkan di luar repo dan batasi aksesnya; `.gitignore` bukan satu-satunya perlindungan.
3. Verifikasi host key SSH melalui kanal tepercaya. Jangan mematikan verifikasi atau menerima semua host key agar koneksi lolos. Host key berubah harus menghentikan koleksi dan dilaporkan.
4. Usahakan akun monitoring dengan hak minimum yang didukung perangkat; perubahan akun tetap memerlukan izin Zidan. Collector tidak menjalankan perintah konfigurasi walaupun akun uji memiliki hak admin.
5. Jalankan collector dari jaringan yang memang boleh menjangkau tiga AP; batasi target ke inventaris yang disetujui.
6. Dashboard/API tidak dibuka ke internet tanpa persetujuan. Gunakan HTTPS saat akses operasional dan pembatasan jaringan yang sesuai.
7. Database memakai akun aplikasi berhak minimum, kredensial terpisah, dan akses jaringan terbatas.
8. Log hanya memuat device ID, waktu, durasi, status, serta kode error aman. Jangan menyimpan respons rahasia atau password.
9. Tentukan backup, retensi, autostart, dan restart service sesuai OS server. `systemd` hanya pilihan untuk Linux; jangan menganggap server target sudah Linux atau MariaDB sudah tersedia.

## 10. Tahap pengerjaan dan gerbang kelulusan

Urutan ini milestone berbasis bukti, bukan janji tanggal selesai. Pekerjaan implementasi berikutnya mengikuti review dokumen ini.

| Tahap | Penanggung jawab | Hasil | Kriteria selesai |
|---|---|---|---|
| M0 — Konsep dan keputusan | Project Lead + Zidan | Dokumen ini, scope serta keputusan terbuka | Zidan menyetujui arah, batas MVP, dan keputusan yang diperlukan untuk tahap berikutnya |
| M1 — Parser lokal | Web Developer; QA menguji | Parser dan fixture asli, satu perintah uji yang dapat dijalankan | Angka sampel benar; field rusak/hilang tidak menjadi nol; metrik valid lain tetap tersedia |
| M2a — SSH otomatis satu AP | Web Developer; Zidan menyediakan akses aman | Koleksi APOfficeLT1 dengan timestamp, timeout, dan host-key verification | Beberapa siklus nyata berhasil; salah akses/timeout diuji tanpa perubahan AP; bukti berbeda dari fixture |
| M2b — Perluasan tiga AP | Web Developer; QA menguji isolasi | Identitas dan sumber metrik tiap AP terverifikasi, polling terbatas | Satu AP timeout tidak menghambat dua AP lain; tidak ada overlap; perangkat tak didukung dilabeli, bukan diasumsikan UniFi |
| M3 — DB dan API | Web Developer; QA menguji | Migrasi, seed tiga AP, histori, health, API terautentikasi | Data nyata tersimpan dan terbaca; error/null/timestamp benar; akses tanpa autentikasi ditolak |
| M4 — Dashboard | Web Developer; QA menguji | Login, ringkasan, detail, grafik, event, realtime | Data berasal dari DB nyata; reconnect sinkron; UI menampilkan error/stale/empty dengan benar |
| M5 — Uji operasional | QA Reviewer + Zidan; developer memperbaiki | Hasil uji, daftar keterbatasan, prosedur menjalankan/restart/backup | Kriteria MVP lulus, keputusan operasional disetujui, tidak ada temuan keamanan/data-loss penghambat |

Pembagian kerja:
- Project Lead menjaga scope, mencatat keputusan, dan menyelaraskan milestone; tidak menetapkan harga/deadline tanpa persetujuan Zidan.
- Web Developer membuat perubahan dan melaporkan file, perintah menjalankan, hasil uji, serta kendala nyata.
- QA Reviewer memverifikasi implementasi dengan bukti dan langkah reproduksi; hitungan fixture tidak dianggap bukti collector otomatis berhasil.
- Zidan memberi akses melalui jalur aman, konfirmasi identitas AP, keputusan kebijakan, lingkungan server, dan penerimaan akhir.

## 11. Acceptance MVP

- [ ] Tiga AP memiliki identitas yang diverifikasi; AP dengan sumber metrik belum didukung dinyatakan terbatas secara eksplisit.
- [ ] Fixture APOfficeLT1 menghasilkan uptime `266591.49`, load `0.10/0.11/0.09`, RAM used `59916288` byte dan sekitar `46.6%`.
- [ ] Kasus `MemAvailable=0`, field hilang/rusak, total tidak valid, dan available di luar rentang diuji.
- [ ] Polling nyata otomatis dibuktikan; fixture tidak digunakan sebagai data live.
- [ ] Timeout terisolasi, concurrency dibatasi, koneksi ditutup, dan pekerjaan AP yang sama tidak overlap.
- [ ] Gagal SSH tidak menetapkan AP down; collector mati membuat data stale, bukan seluruh AP down.
- [ ] Transisi mengikuti kebijakan yang disetujui; event tidak berulang pada keadaan sama atau restart.
- [ ] Semua sampel mempunyai timestamp dan status; nilai gagal `null`, nilai nol valid tetap nol.
- [ ] Histori, timestamp observasi valid terakhir per metrik, dan gap grafik konsisten dengan DB; sampel `partial` load sukses/RAM gagal tidak menyegarkan nilai atau timestamp RAM.
- [ ] REST dan Socket.IO menolak akses tanpa autentikasi; input divalidasi, tidak ada rahasia pada Git/log/respons.
- [ ] Dashboard menampilkan kondisi belum ada data/error/stale; status tidak bergantung warna dan dapat dipakai dengan keyboard/mobile.
- [ ] Socket.IO reconnect mengambil ulang snapshot; kegagalan DB tidak dipresentasikan sebagai penyimpanan sukses.
- [ ] Aplikasi dijalankan pada server target yang disetujui; health, restart, backup, serta retensi diuji atau diberi blocker eksplisit.

## 12. Keputusan yang masih diperlukan

| Keputusan | Status | Dibutuhkan sebelum |
|---|---|---|
| Model/firmware dan keluaran sumber metrik APOfficeLT2 serta APNUSANTARA | Belum tersedia | M2b |
| Mekanisme akses password otomatis yang aman dan verifikasi host key | Belum dipilih | M2a |
| Versi Node.js LTS khusus proyek | Belum dipilih | M1 |
| OS/lokasi server, jaringan ke AP, MariaDB, dan sumber daya host | Belum dikonfirmasi; mesin lokal Windows bukan otomatis server production | M3 dan uji deployment |
| Interval, timeout, concurrency, serta batas stale | Usulan pada bagian 4.2 | M2 dan uji status |
| Ambang down/recovery serta alarm resource | Usulan 3 gagal/2 sukses; alarm resource belum dipilih | Pengaktifan event/alarm |
| Mekanisme autentikasi dan siapa yang boleh melihat dashboard | Belum dipilih | M3 |
| Retensi histori, backup, dan batas query final | Belum ditentukan | Uji operasional berkelanjutan |
| Branding/logo dan kebutuhan tampilan khusus | Belum tersedia | Finalisasi M4 |
| Deadline, anggaran/batas usaha, dan prioritas tambahan | Belum disepakati | Komitmen jadwal/biaya |

## 13. Asal informasi

Dokumen memakai percakapan bersama di room **Project Monitoring AP**, bukan dokumentasi vendor yang baru diambil:
- Usulan awal Zidan: stack, rancangan collector/API, pembatasan MVP tiga AP.
- Daftar nama/IP dari Zidan dan laporan uji jaringan Web Developer serta Project Lead.
- Keluaran `info`, `uptime`, `free`, dan `/proc/*` APOfficeLT1 yang dikirim Zidan.
- Persetujuan Zidan untuk mencoba collector sesuai perangkat terverifikasi.
- Pemeriksaan hitungan sampel dan kriteria parser dari QA Reviewer.
- Pemeriksaan repo langsung saat penulisan dokumen.

Seluruh aturan yang belum dikonfirmasi diberi label usulan atau keputusan terbuka. Dokumen ini tidak menyatakan pengujian parser, SSH otomatis, database, atau dashboard sudah lulus.
