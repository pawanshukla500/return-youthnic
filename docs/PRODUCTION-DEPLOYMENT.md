# Production Deployment Guide: Return App

Target Domain: `https://return.youthnic.shop`  
Organization: VB Exports  
Throughput Target: 2,000+ scanned return items / day  

---

## 1. Architecture Overview

- **Frontend**: Single Page Application built with React 19 + TypeScript + Vite, served statically from `dist/` or through Express.
- **Backend**: Express 4 server on Node.js 22+ with strict TypeScript (`tsx` runtime or compiled `dist/`).
- **Database**: PostgreSQL 15+ with enforced TLS certificate validation and connection pooling.
- **Session Layer**: Server-side opaque sessions in PostgreSQL (`user_sessions`), authenticated via `HttpOnly`, `SameSite=Lax`, `Secure` cookies with 30-day warehouse device persistence and immediate server-side revocation.
- **Reporting Layer**: Automated Resend email integration with PostgreSQL advisory locking (`pg_try_advisory_lock`) to prevent duplicate executions across replicas.

---

## 2. Domain & DNS Configuration

To configure `return.youthnic.shop`:
1. **DNS Record**:
   - For PaaS (Railway / Render): Add a `CNAME` record pointing `return` to the assigned hosting domain (e.g. `your-app.up.railway.app`).
   - For VPS / Cloud VM: Add an `A` record pointing `return` to the public IPv4 address of the reverse proxy server.
2. **TLS / HTTPS Certificate**:
   - Managed automatic TLS via Let's Encrypt or Cloudflare SSL.
   - Enforce HTTP to HTTPS redirection (301 Permanent Redirect).
   - HSTS header recommended: `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

---

## 3. Reverse Proxy Configuration (Nginx Example)

When deploying behind Nginx or Cloudflare, ensure proxy headers are forwarded properly so that `app.set("trust proxy", 1)` correctly detects the secure HTTPS protocol and client IP addresses:

```nginx
server {
    listen 80;
    server_name return.youthnic.shop;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name return.youthnic.shop;

    ssl_certificate /etc/letsencrypt/live/return.youthnic.shop/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/return.youthnic.shop/privkey.pem;

    client_max_body_size 30M; # Accommodates 25MB Excel return files

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 4. Resend Email Domain Setup (`youthnic.shop`)

To deliver operational reports from `return.scan@youthnic.shop`:
1. Log into [Resend Console](https://resend.com/domains).
2. Add domain: `youthnic.shop`.
3. Configure the required DNS records in the domain's DNS provider:
   - **DKIM (CNAME)**: `resend._domainkey.youthnic.shop`
   - **SPF (MX/TXT)**: `feedback-smtp.resend.com`
   - **DMARC (TXT)**: `v=DMARC1; p=none;`
4. Once verified, copy the API key to `RESEND_API_KEY` in production environment settings.
5. In development or staging, if `RESEND_API_KEY` is omitted, the app automatically runs in dry-run mode without failing.

---

## 5. PostgreSQL Security & Invariants

1. **TLS Certificate Verification**:
   - The application strictly enforces certificate verification for remote database hosts.
   - `sslmode=no-verify` is blocked by design in `server/db.ts`.
   - Provide a CA certificate bundle via `DATABASE_SSL_CA_FILE` if connecting to private or custom-signed database clusters.
2. **Schema Invariant**:
   - Migrations are strictly additive. Never drop a table or column.
   - Do not bump `SCHEMA_VERSION`.
   - History tables (`receipt_scans`, `expected_returns`, `upload_batches`, `register_audit_log`) are protected by runtime assertion guards against destructive operations.

---

## 6. Pre-Flight Verification Checklist

Before taking the production domain live:
- [ ] `npm run typecheck` passes with zero errors.
- [ ] `npm run build` succeeds and generates `dist/` bundle.
- [ ] `npm test` runs and passes all 243+ unit and invariant tests.
- [ ] Production environment variables populated (see `.env.production.example`).
- [ ] `GET /api/health` returns HTTP 200 with `{ "ok": true, "database": "connected" }`.
- [ ] Admin user created via `npm run user:create`.
- [ ] Resend test report triggered from Admin > System tab to verify delivery.
- [ ] Warehouse barcode scanner tested on physical devices for input auto-focus and instant submission.
