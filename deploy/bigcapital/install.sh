#!/usr/bin/env bash
#
# Installs Bigcapital (open-source accounting, AGPL-3.0) on its own server, separate from Crewdesk.
# Uses Bigcapital's official Docker setup, plus Caddy in front for automatic HTTPS.
#
#   sudo ./install.sh --domain books.example.com --admin-email you@example.com
#
# Options:
#   --domain NAME        Web address for Bigcapital (point its DNS A record at this server first).
#   --admin-email EMAIL  The only email allowed to sign up (the first account). Others are invited from inside Bigcapital.
#   --dir PATH           Where to install (default /opt/bigcapital).
#   --no-https           Skip Caddy; Bigcapital answers on http://localhost:8080 only (for testing).
#   --smtp-host/--smtp-port/--smtp-user/--smtp-pass/--smtp-from   Outgoing email (optional; can be added to .env later).
#
# Safe to run again: it keeps the existing .env (and its passwords) and only fills in what's missing.
set -euo pipefail

DOMAIN=""; ADMIN_EMAIL=""; DIR="/opt/bigcapital"; HTTPS=1
SMTP_HOST=""; SMTP_PORT="587"; SMTP_USER=""; SMTP_PASS=""; SMTP_FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --no-https) HTTPS=0; shift ;;
    --smtp-host) SMTP_HOST="$2"; shift 2 ;;
    --smtp-port) SMTP_PORT="$2"; shift 2 ;;
    --smtp-user) SMTP_USER="$2"; shift 2 ;;
    --smtp-pass) SMTP_PASS="$2"; shift 2 ;;
    --smtp-from) SMTP_FROM="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done
if [ "$HTTPS" = 1 ] && [ -z "$DOMAIN" ]; then echo "Pass --domain (e.g. books.example.com), or --no-https to test locally." >&2; exit 1; fi
if [ -z "$ADMIN_EMAIL" ]; then echo "Pass --admin-email: the email you'll sign up with." >&2; exit 1; fi
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

say() { printf '\n==> %s\n' "$*"; }
KIT="$(cd "$(dirname "$0")" && pwd)"

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required (docker compose)." >&2; exit 1; }

# 2. Bigcapital's official files (docker/ folder, production compose file, settings template)
say "Downloading Bigcapital's official setup files into $DIR"
mkdir -p "$DIR"
TMP="$(mktemp -d)"
git clone --quiet --depth 1 --branch main https://github.com/bigcapitalhq/bigcapital.git "$TMP/bc" 2>/dev/null \
  || git clone --quiet --depth 1 https://github.com/bigcapitalhq/bigcapital.git "$TMP/bc"
rm -rf "$DIR/docker"
cp -r "$TMP/bc/docker" "$DIR/docker"
cp "$TMP/bc/docker-compose.prod.yml" "$DIR/docker-compose.prod.yml"
cp "$TMP/bc/.env.example" "$DIR/.env.example"
rm -rf "$TMP"
cp "$KIT/bigcapital.sh" "$DIR/bigcapital.sh" && chmod +x "$DIR/bigcapital.sh"

# 3. Settings (.env): strong random passwords, your address, sign-up limited to you
cd "$DIR"
[ -f .env ] || cp .env.example .env
chmod 600 .env
rand() { openssl rand -hex "$1"; }
# set KEY VALUE: replace the line, or add it
set_env() { if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }
# fill KEY VALUE: only if empty or still the template's default
fill_env() { local cur; cur="$(grep -E "^$1=" .env | head -1 | cut -d= -f2- || true)"; if [ -z "$cur" ] || [ "$cur" = "${3:-}" ]; then set_env "$1" "$2"; fi; }
say "Writing settings to $DIR/.env (passwords are generated and kept there)"
fill_env APP_JWT_SECRET "$(rand 48)"
fill_env DB_PASSWORD "$(rand 24)" bigcapital
fill_env DB_ROOT_PASSWORD "$(rand 24)" root
fill_env CLICKHOUSE_PASSWORD "$(rand 24)"
fill_env GARAGE_RPC_SECRET "$(rand 32)"
fill_env GARAGE_ADMIN_TOKEN "$(rand 32)"
set_env GOTENBERG_URL "http://gotenberg:3000"
set_env GOTENBERG_DOCS_URL "http://server:3000/public/"
set_env SIGNUP_ALLOWED_EMAILS "$ADMIN_EMAIL"
if [ "$HTTPS" = 1 ]; then
  set_env BASE_URL "https://$DOMAIN"
  # Bigcapital's own proxy only listens on this machine; Caddy serves the public HTTPS address.
  set_env PUBLIC_PROXY_PORT "127.0.0.1:8080"
  set_env PUBLIC_PROXY_SSL_PORT "127.0.0.1:8443"
else
  set_env BASE_URL "http://localhost:8080"
  set_env PUBLIC_PROXY_PORT "127.0.0.1:8080"
  set_env PUBLIC_PROXY_SSL_PORT "127.0.0.1:8443"
fi
if [ -n "$SMTP_HOST" ]; then
  set_env MAIL_HOST "$SMTP_HOST"; set_env MAIL_PORT "$SMTP_PORT"; set_env MAIL_USERNAME "$SMTP_USER"
  set_env MAIL_PASSWORD "$SMTP_PASS"; set_env MAIL_SECURE "$([ "$SMTP_PORT" = 465 ] && echo true || echo false)"
  set_env MAIL_FROM_ADDRESS "${SMTP_FROM:-$SMTP_USER}"; set_env MAIL_FROM_NAME "Bigcapital"
fi

COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env"

# 4. Start everything (the database migration runs once and exits)
say "Downloading images and starting Bigcapital (this takes a few minutes the first time)"
$COMPOSE pull --quiet --ignore-buildable 2>/dev/null || $COMPOSE pull --quiet || true
$COMPOSE build --quiet
$COMPOSE up -d
say "Waiting for the database setup to finish"
for _ in $(seq 1 180); do
  state="$(docker inspect -f '{{.State.Status}}' bigcapital-database-migration 2>/dev/null || echo missing)"
  [ "$state" = "exited" ] && break
  sleep 2
done
code="$(docker inspect -f '{{.State.ExitCode}}' bigcapital-database-migration 2>/dev/null || echo 1)"
if [ "$code" != 0 ]; then
  echo "The database setup failed. See: cd $DIR && ./bigcapital.sh logs database_migration" >&2
  exit 1
fi

# 5. File storage (Garage): create the storage area and its access key once, then save the key in .env
if ! grep -qE '^S3_ACCESS_KEY_ID=.+' .env || ! grep -qE '^S3_SECRET_ACCESS_KEY=.+' .env; then
  say "Setting up file storage"
  G="docker exec bigcapital-garage /garage"
  for _ in $(seq 1 30); do $G status >/dev/null 2>&1 && break; sleep 2; done
  NODE="$($G node id 2>/dev/null | head -1 | cut -d@ -f1)"
  $G layout assign "$NODE" -z dc1 -c 10G >/dev/null 2>&1 || true
  $G layout apply --version 1 >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do $G status 2>/dev/null | grep -q "HEALTHY\|Healthy\|NO ROLE ASSIGNED" && break; sleep 2; done
  $G bucket create bigcapital >/dev/null 2>&1 || true
  # Reuse the key if an earlier run already made it; otherwise create it.
  if $G key info bigcapital-app >/dev/null 2>&1; then
    OUT="$($G key info bigcapital-app --show-secret 2>&1)"
  else
    OUT="$($G key create bigcapital-app 2>&1)"
  fi
  KEY_ID="$(echo "$OUT" | awk '/Key ID/{print $NF}' | head -1)"
  SECRET="$(echo "$OUT" | awk '/Secret key/{print $NF}' | head -1)"
  [ -n "$KEY_ID" ] && [ -n "$SECRET" ] || { echo "Couldn't get the storage key. Output was:"; echo "$OUT" | grep -v -i secret; exit 1; } >&2
  # Garage's syntax: bucket allow <bucket> --key <key> --read --write --owner
  $G bucket allow bigcapital --key "$KEY_ID" --read --write --owner >/dev/null
  set_env S3_ACCESS_KEY_ID "$KEY_ID"
  set_env S3_SECRET_ACCESS_KEY "$SECRET"
  $COMPOSE up -d server
fi

# 6. HTTPS with Caddy (gets and renews a free certificate automatically)
if [ "$HTTPS" = 1 ]; then
  say "Starting Caddy for https://$DOMAIN"
  mkdir -p caddy
  printf '%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:8080\n}\n' "$DOMAIN" > caddy/Caddyfile
  docker rm -f bigcapital-caddy >/dev/null 2>&1 || true
  docker run -d --name bigcapital-caddy --restart unless-stopped --network host \
    -v "$DIR/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" -v bigcapital_caddy_data:/data -v bigcapital_caddy_config:/config \
    caddy:2 >/dev/null
fi

say "Done."
if [ "$HTTPS" = 1 ]; then
  echo "Open https://$DOMAIN and sign up with $ADMIN_EMAIL (the only email allowed to sign up)."
  echo "If the page doesn't load yet, check that $DOMAIN points to this server and ports 80 and 443 are open."
else
  echo "Open http://localhost:8080 and sign up with $ADMIN_EMAIL."
fi
echo "Manage it with: cd $DIR && ./bigcapital.sh (status | logs | restart | stop | start | upgrade | backup)"
