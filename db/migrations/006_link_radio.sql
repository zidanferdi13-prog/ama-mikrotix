-- Kesehatan uplink ethernet (if_table[0]) dan radio per band (radio_table[].athstats) dari
-- mca-dump yang sudah diambil tiap 60 s — tanpa perintah SSH baru.
-- NULL = tidak terukur (vendor tanpa dukungan, field tidak ada, atau nilai di luar rentang
-- fisik), tidak pernah 0. Counter error/drop kumulatif sejak boot AP.
-- Idempoten: provision-host.sh menerapkan ulang semua berkas migrasi.

ALTER TABLE device_metrics
  ADD COLUMN IF NOT EXISTS eth_speed_mbps SMALLINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS eth_full_duplex TINYINT(1) NULL,
  ADD COLUMN IF NOT EXISTS eth_up TINYINT(1) NULL,
  ADD COLUMN IF NOT EXISTS eth_rx_errors BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS eth_tx_errors BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS eth_rx_dropped BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS eth_tx_dropped BIGINT UNSIGNED NULL;

-- Radio per band (ng = 2,4 GHz, na = 5 GHz). cu_* persen (0–100), noise_floor dBm.
ALTER TABLE device_metrics
  ADD COLUMN IF NOT EXISTS radio_ng_channel SMALLINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS radio_ng_cu_total TINYINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS radio_ng_cu_interf TINYINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS radio_ng_noise_floor SMALLINT NULL,
  ADD COLUMN IF NOT EXISTS radio_ng_tx_retries BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS radio_ng_tx_packets BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS radio_na_channel SMALLINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS radio_na_cu_total TINYINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS radio_na_cu_interf TINYINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS radio_na_noise_floor SMALLINT NULL,
  ADD COLUMN IF NOT EXISTS radio_na_tx_retries BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS radio_na_tx_packets BIGINT UNSIGNED NULL;
