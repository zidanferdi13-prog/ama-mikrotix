#!/usr/bin/env bash
# Provision host untuk Project Monitoring AP: MariaDB + nginx + unit systemd.
# Jalankan dari root repo:  sudo scripts/provision-host.sh
# Idempoten: aman diulang (mis. setelah `npm run build -w @ama/web` untuk sinkron dist).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
NODE_BIN="${AMA_NODE_BIN:-$RUN_HOME/.local/node-v20.19.5-linux-arm64/bin/node}"
WEB_ROOT="/srv/ama-mikrotix/apps/web/dist"

[[ $EUID -eq 0 ]] || { echo "harus root (sudo)"; exit 1; }
[[ -x "$NODE_BIN" ]] || { echo "node 20 tidak ada di $NODE_BIN (set AMA_NODE_BIN)"; exit 1; }
[[ -f "$REPO/.env" ]] || { echo "buat $REPO/.env dulu (cp .env.example .env)"; exit 1; }
[[ -f "$REPO/apps/web/dist/index.html" ]] || { echo "build dashboard dulu: npm run build -w @ama/web"; exit 1; }

# --- 1. paket ---
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y mariadb-server nginx

# --- 2. database + akun aplikasi berhak minimum ---
systemctl enable --now mariadb

DB_NAME="$(grep -E '^AMA_DB_NAME=' "$REPO/.env" | cut -d= -f2-)"
DB_USER="$(grep -E '^AMA_DB_USER=' "$REPO/.env" | cut -d= -f2-)"
DB_PASS="$(grep -E '^AMA_DB_PASSWORD=' "$REPO/.env" | cut -d= -f2-)"
: "${DB_NAME:=ama_monitoring}" "${DB_USER:=ama_app}"
[[ -n "$DB_PASS" ]] || { echo "AMA_DB_PASSWORD kosong di .env"; exit 1; }

mysql --protocol=socket -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

# Migrasi + seed dijalankan sebagai root: akun aplikasi sengaja tanpa hak DDL.
for f in "$REPO"/db/migrations/*.sql "$REPO"/db/seed/*.sql; do
  echo "apply $(basename "$f")"
  mysql --protocol=socket -uroot "$DB_NAME" < "$f"
done

# --- 3. file rahasia SSH (di luar repo, 600) ---
# Ditulis server saat password diisi dari halaman Perangkat; direktori harus
# bisa ditulis user layanan (temp + rename) karena itu dimiliki $RUN_USER.
SECRETS_FILE="/etc/ama/secrets.json"
install -d -m 750 -o "$RUN_USER" -g "$RUN_USER" /etc/ama
if [[ ! -f "$SECRETS_FILE" ]]; then
  printf '{}\n' > "$SECRETS_FILE"
fi
chown "$RUN_USER:$RUN_USER" "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"

# --- 4. dashboard statis (nginx worker tidak bisa menembus $RUN_HOME 700) ---
install -d -m 755 "$WEB_ROOT"
rsync -a --delete "$REPO/apps/web/dist/" "$WEB_ROOT/"

# --- 5. unit systemd ---
write_unit() {
  local name="$1" desc="$2" entry="$3"
  cat > "/etc/systemd/system/$name" <<UNIT
[Unit]
Description=$desc
After=network-online.target mariadb.service
Wants=network-online.target
Requires=mariadb.service

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$REPO
EnvironmentFile=$REPO/.env
ExecStart=$NODE_BIN $entry
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
}

write_unit ama-server.service "AMA monitoring REST + Socket.IO" "apps/server/src/index.js"
write_unit ama-collector.service "AMA monitoring collector (ping + SSH)" "apps/collector/src/main.js"

# --- 5b. backup harian: root via socket (tanpa password), simpan 7 dump terakhir ---
install -d -m 700 /var/backups/ama
cat > /etc/systemd/system/ama-backup.service <<'UNIT'
[Unit]
Description=AMA monitoring: dump database harian
Requires=mariadb.service
After=mariadb.service

[Service]
Type=oneshot
UMask=0077
# Tulis ke .part lalu rename: dump gagal tidak pernah tampak seperti backup sah.
ExecStart=/bin/bash -c 'set -euo pipefail; f=/var/backups/ama/ama-$(date +%%F).sql.gz; mariadb-dump --single-transaction --routines ama_monitoring | gzip > "$f.part"; mv "$f.part" "$f"; ls -1t /var/backups/ama/ama-*.sql.gz | tail -n +8 | xargs -r rm -f'
UNIT
cat > /etc/systemd/system/ama-backup.timer <<'UNIT'
[Unit]
Description=AMA monitoring: jadwal dump database harian

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# --- 6. nginx: satu origin untuk dashboard + /api + /socket.io ---
cat > /etc/nginx/sites-available/ama-mikrotix.conf <<NGINX
server {
  listen 80 default_server;
  server_name _;

  root $WEB_ROOT;
  index index.html;

  location / {
    try_files \$uri /index.html;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
  }

  location /socket.io/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/ama-mikrotix.conf /etc/nginx/sites-enabled/ama-mikrotix.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

systemctl daemon-reload
systemctl enable --now ama-server ama-collector ama-backup.timer

echo
echo "selesai. langkah berikut:"
echo "  1. systemctl restart ama-server ama-collector   # wajib: unit memuat .env saat start"
echo "  2. curl -s localhost:3001/api/health"
echo "  3. buka dashboard http://<ip-host>/ lalu isi password SSH AP di halaman Perangkat"
echo "     (password tersimpan di $SECRETS_FILE, tidak pernah masuk DB)"
