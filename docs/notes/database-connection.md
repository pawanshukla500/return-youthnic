# Database connection

What was wrong on 2026-10-10, what was changed, and what is verified.

## Symptom

The app showed the database as disconnected. `/api/health` answered `{"ok":false,"database":"disconnected"}` and
`/api/dashboard` and every other data route answered HTTP 503.

## Cause

The VPS `srv1845788.hstgr.cloud` (IP `200.141.1.119`) runs **two different Postgres servers**:

- A **Docker container** `postgresql-6k6a-postgresql-1` (`postgres:17`) that publishes `0.0.0.0:5433 -> 5432`, with
  `POSTGRES_DB=scapingtool` and its own TLS certificate. This is the port the original `.env` used.
- A **host-level PostgreSQL 16.15** on `0.0.0.0:5432`, which holds the databases `postgres`, `return-scan_youthnic`
  and `scapingtoo`.

The original `.env` pointed at the **container on 5433**, which is reachable **only on the server itself** (its own
`psql` works). From this Windows machine, TCP to 5433 **times out on both IPv4 and IPv6**, so the app could never
connect. The host instance on 5432 **is** reachable.

Two more things had to be right for the host instance:

- It presents a **self-signed** certificate whose only name is `srv1845788.hstgr.cloud`, so the URL must use that host
  name (not the IP) and a CA must be supplied.
- `DATABASE_URL` had no `sslmode`, and no `DATABASE_SSL_CA_FILE` was set, so there was no way for the certificate to be
  trusted.

The user confirmed the host instance on 5432 is the intended one (the container on 5433 belongs to another project,
`scapingtool`). `200.141.1.119` is the address `srv1845788.hstgr.cloud` resolves to, so it was the right machine: only
the port and the certificate trust were wrong.

## Fix

`.env` was changed to:

- host `srv1845788.hstgr.cloud` (the name the certificate matches), port `5432`.
- `?sslmode=verify-full` on `DATABASE_URL`.
- `DATABASE_SSL_CA_FILE=certs/db-ca.pem`.

The server's certificate was fetched (Postgres TLS needs an SSLRequest first, so a plain TLS client cannot read it)
and saved to `certs/db-ca.pem`. `certs/` is added to `.gitignore`, because the certificate is specific to this one
server. The certificate check was **not** weakened: `sslmode=verify-full` keeps both the certificate and the host
name checked.

The database itself had **no schema** (`public` held zero tables), so the app had never created its tables. Starting
the API once created them.

The port was not opened, and the 5433 container was not touched. If the 5433 container is ever needed instead, the
documented route is an SSH tunnel to the VPS (it is not reachable from the PC).

## Verified

- A certificate-checked connection succeeds: `SELECT 1` returns, the database is `return-scan_youthnic`, the user is
  `pawanshukla`, and the server is PostgreSQL 16.15.
- The API starts and `/api/health` returns `{"ok":true,"database":"connected","name":"return-scan_youthnic"}`.
- The schema was created on that start: 41 tables in `public`, including `product_master` and its new `image_url`
  column.

## Not verified

- No sign-in user exists yet, so no screen has been opened against this database. Create the administrator with
  `npm run user:create` (see CLAUDE.md, Pending from the user).
- `TEST_DATABASE_URL` is not set, so the two database test files are still skipped.
- The 5433 container (`scapingtool`) was not opened or queried; it is out of scope for this app.
