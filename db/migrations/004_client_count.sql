-- Jumlah client Wi-Fi per sampel sistem (UniFi `mca-dump`, jumlah num_sta seluruh VAP).
-- NULL = tidak terukur (vendor tanpa dukungan atau output gagal dibaca), bukan nol.
-- Idempoten: provision-host.sh menerapkan ulang semua berkas migrasi.

ALTER TABLE device_metrics
  ADD COLUMN IF NOT EXISTS client_count INT UNSIGNED NULL;
