-- Alert proaktif: rule engine + lifecycle active → acknowledged → resolved.
-- Aditif dan idempoten: aman dijalankan ulang. monitoring_events tidak disentuh.
-- Catatan: db/migrate.js memecah per titik koma, jadi tidak ada titik koma di dalam statement.

CREATE TABLE IF NOT EXISTS alerts (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rule_id          VARCHAR(64) NOT NULL,
  severity         ENUM('critical','warning','info') NOT NULL,
  status           ENUM('active','acknowledged','resolved') NOT NULL DEFAULT 'active',
  -- NULL = insiden lintas perangkat (mis. collector).
  device_id        INT UNSIGNED NULL,
  -- Target di bawah perangkat, mis. MAC client (lowercase).
  target           VARCHAR(64) NULL,
  -- rule_id|device_id|target — identitas kondisi untuk dedup.
  dedup_key        VARCHAR(191) NOT NULL,
  title            VARCHAR(255) NOT NULL,
  first_seen_at    DATETIME(3) NOT NULL,
  last_seen_at     DATETIME(3) NOT NULL,
  updated_at       DATETIME(3) NOT NULL,
  resolved_at      DATETIME(3) NULL,
  acknowledged_at  DATETIME(3) NULL,
  acknowledged_by  VARCHAR(80) NULL,
  reopen_count     INT UNSIGNED NOT NULL DEFAULT 0,
  evidence         JSON NULL,
  diagnosis        JSON NULL,
  -- Hanya satu alert terbuka per dedup_key: UNIQUE mengabaikan NULL (status resolved).
  open_key         VARCHAR(191) AS (IF(status = 'resolved', NULL, dedup_key)) PERSISTENT,

  PRIMARY KEY (id),
  UNIQUE KEY uq_alerts_open (open_key),
  KEY idx_alerts_status (status, severity),
  KEY idx_alerts_device (device_id, first_seen_at),
  KEY idx_alerts_updated (updated_at),
  KEY idx_alerts_dedup (dedup_key, resolved_at),
  CONSTRAINT fk_alerts_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Riwayat perubahan status (audit): siapa, kapan, dari → ke.
CREATE TABLE IF NOT EXISTS alert_events (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  alert_id     BIGINT UNSIGNED NOT NULL,
  at           DATETIME(3) NOT NULL,
  from_status  VARCHAR(16) NULL,
  to_status    VARCHAR(16) NOT NULL,
  actor        VARCHAR(80) NOT NULL,
  note         JSON NULL,

  PRIMARY KEY (id),
  KEY idx_alert_events_alert (alert_id, at),
  CONSTRAINT fk_alert_events_alert FOREIGN KEY (alert_id) REFERENCES alerts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Snapshot client per siklus sistem. Identitas = MAC + AP.
-- Hostname/IP sengaja tidak disimpan (privasi). Retensi 24 jam oleh collector.
CREATE TABLE IF NOT EXISTS client_observations (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id    INT UNSIGNED NOT NULL,
  mac          CHAR(17) NOT NULL,
  observed_at  DATETIME(3) NOT NULL,
  signal_dbm   SMALLINT NULL,
  rssi         SMALLINT NULL,
  rx_bytes     BIGINT UNSIGNED NULL,
  tx_bytes     BIGINT UNSIGNED NULL,
  uptime_s     INT UNSIGNED NULL,
  radio        VARCHAR(8) NULL,
  vap          VARCHAR(32) NULL,

  PRIMARY KEY (id),
  KEY idx_client_obs_device (device_id, observed_at),
  KEY idx_client_obs_mac (device_id, mac, observed_at),
  -- pruneClients() menghapus berdasarkan observed_at saja.
  KEY idx_client_obs_time (observed_at),
  CONSTRAINT fk_client_obs_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
