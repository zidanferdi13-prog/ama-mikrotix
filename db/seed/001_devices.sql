-- Seed tiga AP §6: inventaris terkontrol, belum ada halaman CRUD.
-- Identitas APOfficeLT1 terverifikasi; dua lainnya belum — jangan diasumsikan UniFi.
INSERT INTO devices (id, name, ip, vendor, model, firmware, username, identity_verified)
VALUES
  (1, 'APOfficeLT1', '192.168.5.228', 'Ubiquiti', 'UAP-AC-LR', '6.8.2.15592', 'admin', 1),
  (2, 'APOfficeLT2', '192.168.5.226', NULL, NULL, NULL, 'admin', 0),
  (3, 'APNUSANTARA', '192.168.5.120', NULL, NULL, NULL, 'MORTINDO', 0)
ON DUPLICATE KEY UPDATE name = VALUES(name), ip = VALUES(ip), username = VALUES(username);

INSERT INTO collector_heartbeat (id, last_heartbeat_at, last_error_code)
VALUES (1, '1970-01-01 00:00:00.000', 'never_started')
ON DUPLICATE KEY UPDATE id = id;
