-- Pengelolaan perangkat dari dashboard §6 (revisi): tabel `devices` menjadi
-- sumber tunggal daftar AP — config/devices.json dihapus.
-- Idempoten: provision-host.sh menerapkan ulang semua berkas migrasi.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS enabled TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS notes VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS secret_updated_at DATETIME(3) NULL;

-- Backfill fingerprint host key tiga AP yang sudah terpasang (dulu di config/devices.json).
-- Hanya mengisi bila masih kosong agar tidak menimpa perubahan dari dashboard.
UPDATE devices SET host_key_fingerprint = 'sha256:JxuhQ7joWRHUY6fO2ZjOmUWTc5YgTutBIlV/12098/k='
  WHERE id = 1 AND (host_key_fingerprint IS NULL OR host_key_fingerprint = '');
UPDATE devices SET host_key_fingerprint = 'sha256:YCPXecrRWsX/aLUxeF6Mo25urcwnct/jB/aPQE//qWY='
  WHERE id = 2 AND (host_key_fingerprint IS NULL OR host_key_fingerprint = '');
UPDATE devices SET host_key_fingerprint = 'sha256:6AKZIKq+OchBMLm0zyyh3P2LC6EV19sAKSkZCvDpzkU='
  WHERE id = 3 AND (host_key_fingerprint IS NULL OR host_key_fingerprint = '');
