#!/usr/bin/env bash
# ==============================================================================
# Return App VPS Watchdog & Auto-Heal Alert Daemon
# Checks container health, internal HTTP, and public Traefik routing every minute.
# Auto-heals unhealthy/zombie containers and sends instant WhatsApp alerts.
# ==============================================================================
set -u

STATE_FILE="/var/run/return-app-watchdog.state"
APP_DIR="/opt/return-app/Return-App"
CONTAINER_NAME="Return-App"

# WhatsApp Alert Configuration
WA_URL="https://wa.youthnic.shop"
WA_AUTH="returnorders@vbexports.co.in:Xchange4WA$"
WA_GROUP="919825149497-1631941133@g.us"
WA_TAG_USER="916306361624@s.whatsapp.net"

# Check if overridden in .env
if [ -f "${APP_DIR}/.env" ]; then
  _url=$(grep -E '^WHATSAPP_API_URL=' "${APP_DIR}/.env" | cut -d'=' -f2- | tr -d '"'\'' ')
  [ -n "$_url" ] && WA_URL="$_url"
  _auth=$(grep -E '^WHATSAPP_BASIC_AUTH=' "${APP_DIR}/.env" | cut -d'=' -f2- | tr -d '"'\'' ')
  [ -n "$_auth" ] && WA_AUTH="$_auth"
  _group=$(grep -E '^WHATSAPP_GROUP_JID=' "${APP_DIR}/.env" | cut -d'=' -f2- | tr -d '"'\'' ')
  [ -n "$_group" ] && WA_GROUP="$_group"
  _tag=$(grep -E '^WHATSAPP_TAG_USER_JID=' "${APP_DIR}/.env" | cut -d'=' -f2- | tr -d '"'\'' ')
  [ -n "$_tag" ] && WA_TAG_USER="$_tag"
fi

NOW_ISO=$(date '+%Y-%m-%d %H:%M:%S')

send_whatsapp_alert() {
  local msg="$1"
  local auth_b64
  auth_b64=$(printf '%s' "$WA_AUTH" | base64 | tr -d '\n')
  local payload
  payload=$(node -e '
    const [msg, group, tag] = process.argv.slice(1);
    console.log(JSON.stringify({
      phone: group,
      message: msg,
      mentions: [tag]
    }));
  ' "$msg" "$WA_GROUP" "$WA_TAG_USER" 2>/dev/null || cat <<EOF
{"phone":"$WA_GROUP","message":"$msg","mentions":["$WA_TAG_USER"]}
EOF
  )

  curl -s -m 10 -X POST "${WA_URL}/send/message" \
    -H "Authorization: Basic ${auth_b64}" \
    -H "Content-Type: application/json" \
    -d "$payload" >/dev/null 2>&1 || true
}

# 1. Inspect Docker Container
container_exists=0
container_status="missing"
container_health="none"

if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  container_exists=1
  container_status=$(docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}' 2>/dev/null || echo "unknown")
  container_health=$(docker inspect "$CONTAINER_NAME" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo "unknown")
fi

# 2. Check Internal Health Endpoint
internal_code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:3001/api/health" 2>/dev/null || echo "000")

# 3. Check Public Traefik Endpoint
public_code=$(curl -k -s -o /dev/null -w "%{http_code}" -m 5 "https://return.youthnic.shop/api/health" 2>/dev/null || echo "000")

# Determine Health
is_healthy=1
reason=""

if [ "$container_exists" -eq 0 ]; then
  is_healthy=0
  reason="Container $CONTAINER_NAME does not exist."
elif [ "$container_status" != "running" ]; then
  is_healthy=0
  reason="Container $CONTAINER_NAME is not running (Status: $container_status)."
elif [ "$container_health" = "unhealthy" ]; then
  is_healthy=0
  reason="Container $CONTAINER_NAME failed Docker healthcheck (Status: unhealthy)."
elif [ "$internal_code" != "200" ]; then
  is_healthy=0
  reason="Internal API (127.0.0.1:3001) returned HTTP $internal_code."
elif [ "$public_code" != "200" ]; then
  is_healthy=0
  reason="Public domain (https://return.youthnic.shop) returned HTTP $public_code."
fi

# Read previous state
prev_state="HEALTHY"
fail_count=0
last_alert=0

if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE" 2>/dev/null || true
fi

current_time=$(date +%s)

if [ "$is_healthy" -eq 1 ]; then
  # Currently HEALTHY
  if [ "$prev_state" = "DOWN" ]; then
    echo "[$NOW_ISO] [RECOVERED] Return App has recovered to HEALTHY state."
    recovery_msg="✅ *[RECOVERED] Return App is Back Online*

🌐 *Portal:* https://return.youthnic.shop
📊 *Status:* 200 OK (Healthy)
🕒 *Timestamp:* ${NOW_ISO} IST
💡 *Diagnostics:* Internal API ($internal_code), Public Traefik ($public_code), Container ($container_status/$container_health)."

    send_whatsapp_alert "$recovery_msg"
  fi

  cat > "$STATE_FILE" <<EOF
prev_state="HEALTHY"
fail_count=0
last_alert=0
EOF

else
  # Currently UNHEALTHY / DOWN
  fail_count=$((fail_count + 1))
  echo "[$NOW_ISO] [UNHEALTHY] $reason (Consecutive failures: $fail_count)"

  # Trigger auto-heal and alert
  time_since_alert=$((current_time - last_alert))
  
  if [ "$prev_state" = "HEALTHY" ] || [ "$time_since_alert" -ge 1800 ]; then
    alert_msg="🚨 *[ALERT] Return App Service Degradation Detected!*

🌐 *Domain:* https://return.youthnic.shop
⚠️ *Issue:* ${reason}
📊 *Internal API:* HTTP ${internal_code}
🌐 *Public Traefik:* HTTP ${public_code}
🐳 *Container:* ${container_status} (${container_health})
🕒 *Timestamp:* ${NOW_ISO} IST

⚙️ *Action:* Initiating automatic self-healing restart..."

    send_whatsapp_alert "$alert_msg"
    last_alert=$current_time
  fi

  # Self-healing restart
  echo "[$NOW_ISO] [AUTO-HEAL] Restarting $CONTAINER_NAME..."
  if [ "$container_exists" -eq 1 ]; then
    docker restart "$CONTAINER_NAME" >/dev/null 2>&1 || true
  else
    if [ -d "$APP_DIR" ]; then
      cd "$APP_DIR" && docker compose -p return-app -f docker-compose.production.yml --env-file .env up -d >/dev/null 2>&1 || true
    fi
  fi

  # Sleep 15 seconds and re-evaluate
  sleep 15

  post_int_code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:3001/api/health" 2>/dev/null || echo "000")
  post_pub_code=$(curl -k -s -o /dev/null -w "%{http_code}" -m 5 "https://return.youthnic.shop/api/health" 2>/dev/null || echo "000")

  if [ "$post_int_code" = "200" ] && [ "$post_pub_code" = "200" ]; then
    echo "[$NOW_ISO] [AUTO-HEAL SUCCESS] Return App restored to 200 OK after restart."
    healed_msg="✅ *[AUTO-HEALED] Return App Restored Successfully*

🌐 *Portal:* https://return.youthnic.shop
🎉 *Auto-Recovery:* Container restart resolved the issue.
📊 *Status:* HTTP 200 OK
🕒 *Timestamp:* $(date '+%Y-%m-%d %H:%M:%S') IST"
    send_whatsapp_alert "$healed_msg"

    cat > "$STATE_FILE" <<EOF
prev_state="HEALTHY"
fail_count=0
last_alert=0
EOF
  else
    echo "[$NOW_ISO] [AUTO-HEAL FAILED] Service still down after restart (Internal: $post_int_code, Public: $post_pub_code)."
    cat > "$STATE_FILE" <<EOF
prev_state="DOWN"
fail_count=$fail_count
last_alert=$last_alert
EOF
  fi
fi
