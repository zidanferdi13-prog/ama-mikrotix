-- Ping AP → google.com, dijalankan DI AP lewat sesi SSH yang sama dengan metrik sistem
-- (kind = 'system'). Ini latency yang ditampilkan dashboard; latency_ms (ping collector → AP)
-- tetap disimpan tetapi hanya sebagai bukti AP terjangkau dari server.
-- NULL = tidak terukur (SSH gagal, DNS gagal, 100% loss). Status/kode di metric_status.internet.
-- Idempoten: provision-host.sh menerapkan ulang semua berkas migrasi.

ALTER TABLE device_metrics
  ADD COLUMN IF NOT EXISTS internet_latency_ms DECIMAL(10,3) NULL,
  ADD COLUMN IF NOT EXISTS internet_loss_percent TINYINT UNSIGNED NULL;
