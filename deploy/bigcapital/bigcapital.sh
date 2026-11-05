#!/usr/bin/env bash
# Everyday commands for a Bigcapital install made by install.sh. Run from the install folder.
#   ./bigcapital.sh status | logs [service] | start | stop | restart | upgrade | backup
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env"
case "${1:-status}" in
  status) $COMPOSE ps; docker ps --filter name=bigcapital-caddy --format '{{.Names}}: {{.Status}}' ;;
  logs) $COMPOSE logs --tail 200 -f ${2:-} ;;
  start) $COMPOSE up -d; docker start bigcapital-caddy >/dev/null 2>&1 || true ;;
  stop) docker stop bigcapital-caddy >/dev/null 2>&1 || true; $COMPOSE stop ;;
  restart) $COMPOSE restart ;;
  upgrade)
    # Newer server/web app images (the auto-update container also does this hourly), then any database changes.
    $COMPOSE pull --quiet --ignore-buildable 2>/dev/null || $COMPOSE pull --quiet
    $COMPOSE up -d --build
    $COMPOSE run --rm database_migration ;;
  backup)
    # Database dump + uploaded files, into ./backups (keeps the last 14). Copy this folder off the server too.
    mkdir -p backups
    STAMP="$(date +%Y%m%d-%H%M%S)"
    ROOT_PW="$(grep -E '^DB_ROOT_PASSWORD=' .env | cut -d= -f2-)"
    docker exec bigcapital-mysql sh -c "exec mysqldump -uroot -p\"$ROOT_PW\" --all-databases --single-transaction --routines" | gzip > "backups/db-$STAMP.sql.gz"
    docker run --rm -v bigcapital_prod_garage:/garage:ro -v "$PWD/backups:/out" alpine tar czf "/out/files-$STAMP.tar.gz" -C /garage .
    cp .env "backups/env-$STAMP" && chmod 600 "backups/env-$STAMP"
    ls -1t backups/db-*.sql.gz | tail -n +15 | xargs -r rm --
    ls -1t backups/files-*.tar.gz | tail -n +15 | xargs -r rm --
    ls -1t backups/env-* | tail -n +15 | xargs -r rm --
    echo "Backup written to $PWD/backups (db-$STAMP.sql.gz, files-$STAMP.tar.gz)" ;;
  *) echo "Usage: $0 status | logs [service] | start | stop | restart | upgrade | backup" >&2; exit 1 ;;
esac
