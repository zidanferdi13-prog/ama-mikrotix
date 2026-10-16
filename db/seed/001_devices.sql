-- Inventaris awal tiga AP. Sejak pengelolaan perangkat pindah ke dashboard,
-- seed ini hanya MENGISI bila baris belum ada (INSERT IGNORE): perubahan yang
-- dilakukan operator lewat UI tidak boleh ditimpa saat provision dijalankan ulang.
INSERT IGNORE INTO devices (id, name, ip, port, vendor, model, firmware, username, host_key_fingerprint, identity_verified, enabled)
VALUES
  (1, 'APOfficeLT1', '192.168.5.228', 22, 'Ubiquiti', 'UAP-AC-LR', '6.8.2.15592', 'admin', 'sha256:JxuhQ7joWRHUY6fO2ZjOmUWTc5YgTutBIlV/12098/k=', 1, 1),
  (2, 'APOfficeLT2', '192.168.5.226', 22, NULL, NULL, NULL, 'admin', 'sha256:YCPXecrRWsX/aLUxeF6Mo25urcwnct/jB/aPQE//qWY=', 0, 1),
  (3, 'APNUSANTARA', '192.168.5.120', 22, NULL, NULL, NULL, 'MORTINDO', 'sha256:6AKZIKq+OchBMLm0zyyh3P2LC6EV19sAKSkZCvDpzkU=', 0, 1);

INSERT INTO collector_heartbeat (id, last_heartbeat_at, last_error_code)
VALUES (1, '1970-01-01 00:00:00.000', 'never_started')
ON DUPLICATE KEY UPDATE id = id;
