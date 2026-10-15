-- Skema minimum §6: tiga tabel cukup untuk scope awal.
-- Timestamp disimpan UTC. Indeks utama histori: (device_id, kind, observed_at).

CREATE TABLE IF NOT EXISTS devices (
  id                    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name                  VARCHAR(120) NOT NULL,
  ip                    VARCHAR(45) NOT NULL,
  vendor                VARCHAR(80) NULL,
  model                 VARCHAR(120) NULL,
  firmware              VARCHAR(80) NULL,
  port                  SMALLINT UNSIGNED NOT NULL DEFAULT 22,
  username              VARCHAR(80) NULL,
  host_key_fingerprint  VARCHAR(160) NULL,
  identity_verified     TINYINT(1) NOT NULL DEFAULT 0,

  -- Keterjangkauan + keadaan transisi (agar restart tidak membuat transisi palsu).
  reachable             ENUM('unknown','up','down') NOT NULL DEFAULT 'unknown',
  ping_fail_count       INT UNSIGNED NOT NULL DEFAULT 0,
  ping_ok_count         INT UNSIGNED NOT NULL DEFAULT 0,
  last_ping_attempt_at  DATETIME(3) NULL,

  -- Kesegaran per metrik, terpisah dari timestamp percobaan terbaru.
  uptime_last_valid_at  DATETIME(3) NULL,
  load_last_valid_at    DATETIME(3) NULL,
  ram_last_valid_at     DATETIME(3) NULL,
  system_last_valid_at  DATETIME(3) NULL,
  last_collection_status ENUM('ok','partial','error') NULL,

  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_devices_ip (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS device_metrics (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id              INT UNSIGNED NOT NULL,
  kind                   ENUM('ping','system') NOT NULL,
  observed_at            DATETIME(3) NOT NULL,
  received_at            DATETIME(3) NOT NULL,
  collection_status      ENUM('ok','partial','error') NOT NULL,

  reachable              TINYINT(1) NULL,
  latency_ms             DECIMAL(10,3) NULL,
  uptime_seconds         DECIMAL(18,2) NULL,
  load_1                 DECIMAL(10,4) NULL,
  load_5                 DECIMAL(10,4) NULL,
  load_15                DECIMAL(10,4) NULL,
  memory_total_bytes     BIGINT UNSIGNED NULL,
  memory_available_bytes BIGINT UNSIGNED NULL,
  memory_used_bytes      BIGINT UNSIGNED NULL,
  memory_used_percent    DECIMAL(6,3) NULL,

  -- Status/kode error per field; `unsupported` dibedakan dari format rusak.
  metric_status          JSON NULL,

  PRIMARY KEY (id),
  KEY idx_metrics_history (device_id, kind, observed_at),
  CONSTRAINT fk_metrics_device FOREIGN KEY (device_id) REFERENCES devices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS monitoring_events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id   INT UNSIGNED NOT NULL,
  type        VARCHAR(64) NOT NULL,
  started_at  DATETIME(3) NOT NULL,
  changed_at  DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  status      ENUM('aktif','selesai') NOT NULL,
  detail      JSON NULL,

  PRIMARY KEY (id),
  KEY idx_events_device_time (device_id, started_at),
  KEY idx_events_status (status, started_at),
  CONSTRAINT fk_events_device FOREIGN KEY (device_id) REFERENCES devices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
