-- Audit aksi kontrol AP dari dashboard (mis. reboot): siapa, kapan, hasil.
-- Aditif dan idempoten. Catatan: db/migrate.js memecah per titik koma.

CREATE TABLE IF NOT EXISTS device_actions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id     INT UNSIGNED NOT NULL,
  action        ENUM('reboot') NOT NULL,
  requested_by  VARCHAR(80) NOT NULL,
  requested_at  DATETIME(3) NOT NULL,
  -- sent = perintah diterima AP. failed = gagal sebelum/saat exec (lihat error_code).
  status        ENUM('sent','failed') NOT NULL,
  error_code    VARCHAR(64) NULL,

  PRIMARY KEY (id),
  KEY idx_device_actions_device (device_id, requested_at),
  CONSTRAINT fk_device_actions_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
