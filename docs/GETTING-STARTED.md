<!-- Updated 2026-10-10. Messages and paths were checked against the source. Not run. -->
# Getting started

This guide takes you from a copy of the project folder to a running app with a database.

## Prerequisites

- **Node.js (LTS).** The repository does not pin a version: there is no `engines` field, `.nvmrc`, or `.node-version`.
- **npm.** It comes with Node.js. The repository has a `package-lock.json`, so `npm install` gives the same versions each time.
- **PostgreSQL.** A database you can reach from this machine, with a connection string. The version is not pinned. The schema uses `ADD COLUMN IF NOT EXISTS` and `CREATE ... IF NOT EXISTS`, which need PostgreSQL 9.6 or later. The server must offer TLS, because the connection checks the server's certificate (see [Database SSL](CONFIGURATION.md#database-ssl)).
- **Windows (optional).** `RUN.bat` is a Windows batch file. On other systems, use the npm commands directly.

## Installation

1. Get the project folder. Copy it, or clone the repository if you have one. The working copy has no git metadata, so `git clone` does not apply to it.

2. Go into the project folder:

```bash
cd <project folder>
```

3. Install the packages:

```bash
npm install
```

## Configure the environment

1. Create `.env` from the example. On Windows PowerShell or Command Prompt, use `copy`:

```bash
copy .env.example .env
```

2. Open `.env` and set `DATABASE_URL` to your PostgreSQL connection string, with `?sslmode=verify-full` added at the end (or `&sslmode=verify-full` if the string already has a `?`). This makes the app check the database's certificate. If the database uses a private certificate authority, also set `DATABASE_SSL_CA_FILE` to the path of its PEM file. Set `PORT` only if 3001 is already in use.

Every variable is described in [CONFIGURATION.md](CONFIGURATION.md). The OMSGuru variables are needed only for the sync commands.

## First run

Start the API and the web app together:

```bash
npm run dev
```

On Windows you can double-click `RUN.bat` instead. The first run installs packages, warns if `.env` is missing, and opens the web app after about six seconds.

Then check that both servers are up:

- Web app: http://localhost:5173
- API health check: http://localhost:3001/api/health

A healthy database returns `{"ok":true,"database":"connected","name":"<database name>"}`. The health check never shows the connection string.

On the first start with an empty database, the server creates the tables and the six marketplace channels (Amazon, Flipkart, Meesho, Myntra VB, Myntra EJ, Ajio). It creates no users, scans, SKUs, or sample figures. The channels are reference rows. Every later start adds any that are missing and changes nothing else.

## Create the first user

The app has no users until you create one. The password is read from an environment variable, so it does not appear on the command line or in the output. Use a password of at least 10 characters. The command connects with the same verified TLS settings as the app.

Set the password for the current terminal session. In PowerShell, use single quotes so that a `$` in the password is kept as typed:

```bash
$env:NEW_USER_PASSWORD = '<password>'
```

Create the first user as an administrator with access to every marketplace. Only an administrator can open the Admin page and change configuration:

```bash
npm run user:create -- --name "Full Name" --email person@company.com --role Admin --all-marketplaces
```

For a user with access to some marketplaces, list the marketplace names instead. The names must match the list in Admin:

```bash
npm run user:create -- --name "Full Name" --email person@company.com --role Scanner --marketplaces "Myntra VB,Flipkart"
```

The command also takes `--alias <login alias>`, which the user can type in place of the email when signing in.

Run the command again for each user. A duplicate email or login alias is refused with `A user with this email or login alias already exists.`

A user who has no marketplace assigned, and no all-marketplaces flag, can sign in but sees no accounts. Assign at least one account, or use `--all-marketplaces`.

## Sign in

Open http://localhost:5173 and sign in with the user you created. The sign-in form accepts either the user's email or its login alias.

## Common setup problems

- **Health check shows `"database":"disconnected"` or returns HTTP 503.** `DATABASE_URL` is missing, wrong, or the database is not reachable. The server log prints the connection error.
- **The connection fails with a certificate error,** such as `self-signed certificate in certificate chain` or `unable to get local issuer certificate`. Set `DATABASE_SSL_CA_FILE` to the PEM file of the certificate authority. See [Database SSL](CONFIGURATION.md#database-ssl).
- **`The server does not support SSL connections`.** The database does not offer TLS. Turn on TLS on the database. See [Database SSL](CONFIGURATION.md#database-ssl) before you change the URL.
- **`EADDRINUSE` when starting.** Another program uses port 3001 or 5173. Set `PORT` in `.env` to a free port and restart. The web dev server follows `PORT`, but the dev port 5173 is fixed in `vite.config.ts`.
- **Sign-in says "Incorrect email or password."** Check the spelling of the email. The password is the one you set in `NEW_USER_PASSWORD` when you created the user. If you have not created a user yet, see [Create the first user](#create-the-first-user).
- **Signed in, but there are no accounts, or the Admin page is missing.** The user has no marketplace assigned, or is not an administrator. Create the user again with the right flags, or ask an administrator to check the user. The app has no screen for assigning accounts yet.
- **`npm run user:create` says "Set NEW_USER_PASSWORD to a password of at least 10 characters first."** Set the variable in the same terminal before running the command.
- **`npm run user:create` says "Unknown marketplace(s)".** Use the exact names shown in Admin, for example `Myntra VB`.
- **An upload preview says the file cannot be read, with a message about a missing column or the seller account.** Read the message. A Myntra or Meesho file whose seller ID does not match the chosen account is refused as a preview with `fatal` set, and nothing is saved. Choose the account that matches the file. A file with rows for another account is refused with HTTP 400. See the upload routes in [API.md](API.md#uploads).
- **Upload preview shows pending or rejected rows.** Those source rows stay in upload history and are excluded from active lookups. If at least one row is scannable, tick the explicit partial-activation confirmation to activate only the safe rows. If the button stays disabled, the file has no scannable row or has a fatal layout/account problem. For a bulk scanner workbook, switch to scanner-list validation; it never activates data or creates scans.
- **Upload preview says "Select a marketplace before importing."** Choose an account on the Data uploads page before you drop the file.
- **An OMSGuru command stops with "are not set in .env".** Add `OMSGURU_API_TOKEN` and `OMSGURU_CLIENT_ID` to `.env`.

## Next steps

- [AGENTS.md](../AGENTS.md): the entry point for agents, and the order in which to read the project's documents.
- [DEVELOPMENT.md](DEVELOPMENT.md): commands, the rules for every change, and project conventions.
- [TESTING.md](TESTING.md): running the test suite, and reading its output.
- [CONFIGURATION.md](CONFIGURATION.md): every environment variable and default.
- [ARCHITECTURE.md](ARCHITECTURE.md): how the parts fit together.
- [REGISTER.md](REGISTER.md): the return scan register's rules.
