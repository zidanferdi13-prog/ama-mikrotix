-- Heartbeat collector untuk /api/health. Satu baris (id=1).
-- Collector mati → heartbeat tua → API melaporkan collector tidak sehat.

CREATE TABLE IF NOT EXISTS collector_heartbeat (
  id                TINYINT UNSIGNED NOT NULL,
  last_heartbeat_at DATETIME(3) NOT NULL,
  last_error_code   VARCHAR(64) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
