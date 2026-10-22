#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/opt/return-app"
APP_DIR="/opt/return-app/Return-App"
HPANEL_LINK="/docker/return-app"

echo ">>> [1/7] Extracting source code into $APP_DIR..."
tar -xzf "${APP_ROOT}/return-app-source.tar.gz" -C "$APP_DIR"
rm -f "${APP_ROOT}/return-app-source.tar.gz"

echo ">>> [2/7] Configuring environment and certificates..."
cd "$APP_DIR"
if [ -f "${APP_ROOT}/uploaded.env" ]; then
  if [ -f .env ]; then
    while IFS='=' read -r key val || [ -n "$key" ]; do
      [[ "$key" =~ ^#.*$ ]] && continue
      [ -z "$key" ] && continue
      if [ -n "$val" ]; then
        if grep -q "^${key}=" .env; then
          sed -i "s|^${key}=.*|${key}=${val}|" .env
        else
          printf '%s=%s\n' "$key" "$val" >> .env
        fi
      fi
    done < "${APP_ROOT}/uploaded.env"
  else
    cp "${APP_ROOT}/uploaded.env" .env
  fi
  rm -f "${APP_ROOT}/uploaded.env"
fi
chmod 600 .env

ln -sf docker-compose.production.yml docker-compose.yml

echo ">>> [3/7] Registering Hostinger hPanel Docker Manager symlink ($HPANEL_LINK)..."
mkdir -p "$(dirname "$HPANEL_LINK")"
ln -sfn "$APP_DIR" "$HPANEL_LINK"

echo ">>> [4/7] Deploying Docker container via Docker Compose under project 'return-app'..."
docker compose -p return-app -f docker-compose.production.yml --env-file .env up -d --build --remove-orphans

echo ">>> Configuring host cron job for nightly 4:30 AM IST payment sync under VPS docker..."
(crontab -l 2>/dev/null | grep -v 'sync:payment' || true; echo '30 4 * * * docker exec Return-App npm run sync:payment >> /var/log/return-app-payment-sync.log 2>&1') | crontab - || true

echo ">>> [5/7] Cleaning up dangling Docker build images..."
docker image prune -f || true

echo ">>> [6/7] Verifying container status and internal health..."
docker ps --filter "name=Return-App"
healthy=0
for i in {1..20}; do
  if curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
    echo ">>> Health check PASSED at http://127.0.0.1:3001/api/health"
    healthy=1
    break
  fi
  echo "Waiting for container service to become healthy ($i/20)..."
  sleep 3
done

if [ "$healthy" -ne 1 ]; then
  echo "❌ Container failed internal health check. Displaying logs:"
  docker logs Return-App --tail=100 || true
  exit 1
fi

echo ">>> [7/7] Verifying Traefik reverse proxy routing..."
for domain in "return.youthnic.shop" "return.srv1845788.hstgr.cloud"; do
  echo "Testing routing for https://$domain/api/health..."
  curl -k -fsS "https://$domain/api/health" || echo "Note: DNS or cert for $domain might take a moment."
done

echo "=========================================================================="
echo "🎉 Return APP is LIVE on Hostinger VPS!"
echo "Container: Return-App"
echo "Hostinger hPanel: $HPANEL_LINK"
echo "URLs: https://return.youthnic.shop | https://return.srv1845788.hstgr.cloud"
echo "=========================================================================="
