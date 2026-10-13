# Agent roster for the return app (agency-agents)

Last updated: 2026-10-11.

## Installed

33 role files are installed in `.claude/agents/` in this project. The first 20 were copied in full from the local collection at `C:\Users\Pawan Shukla\.claude\agents\`. The 13 added on 2026-10-11 were downloaded from `https://github.com/msitarzewski/agency-agents` (branch `main`) and are listed under [Installed and not in use](#installed-and-not-in-use). Those 13 are present only. Do not start work from them until the user asks.

A role file gives an agent a way of working. It does not give access to the database, to secrets, or to the production system. Every agent, whatever its role, follows the rules in [CLAUDE.md](../../CLAUDE.md) and the invariants in [agent-handoff.md](agent-handoff.md#invariants). No agent reads `.env`.

## Source and limits

- The local collection has 317 role files at its top level. This was counted with a file search on 2026-10-08. An earlier note said 513, which was wrong.
- The first 20 files came from the local collection. On 2026-10-11 the 13 new files were fetched from github.com/msitarzewski/agency-agents, branch `main`, under `engineering/`, `design/`, `testing/`, and `security/`. The original 20 files were not replaced.
- The DashBorad project keeps its own roster in `Desktop\DashBorad Project\docs\SKILLS.md`.

## Roles for this app

### Systems and architecture

| Role | File | What it covers | Used for |
|---|---|---|---|
| Software Architect | `engineering-software-architect.md` | System design, domain-driven design, architectural decisions | Module boundaries (access, register, import, catalog, OMS client), the data layers, the retention design |
| Platform Engineer | `engineering-platform-engineer.md` | Internal developer platform, golden paths, self-serve infrastructure | `RUN.bat`, the dev workflow, scripts, environments, running the verification commands |
| Site Reliability Engineer | `engineering-sre.md` | SLOs, error budgets, observability, toil reduction | Scan-screen latency, retries, OMSGuru throttling, logs, the 503 on a missing database |
| Backend Architect | `engineering-backend-architect.md` | Scalable server design, database architecture, APIs | Express routes, the scope in SQL, transactions, the import pipeline |
| API Platform Engineer | `engineering-api-platform-engineer.md` | Contract-first API design, versioning, auth, rate limits | The OMSGuru client (paging, rate limit) and the `/api` contract in `docs/API.md` |
| DevOps Automator | `engineering-devops-automator.md` | CI/CD, infrastructure automation | Later: scheduling the daily `sync:oms` run and the archive job. There is no CI today |

### Data and database

| Role | File | What it covers | Used for |
|---|---|---|---|
| Data Engineer | `engineering-data-engineer.md` | Pipelines, ETL/ELT, reliable ingestion | Marketplace uploads, the activation rule, the OMS listing and SKU sync, the archive job |
| Database Optimizer | `engineering-database-optimizer.md` | Schema design, indexes, query tuning for PostgreSQL | Indexes on `expected_returns`, `receipt_scans`, `upload_rows`, and the register's union query |
| Database Reliability Engineer | `engineering-database-reliability-engineer.md` | Backup, point-in-time recovery, zero-downtime migrations | Every schema change (additive only), backup before any archive run |

### Quality, review and testing

| Role | File | What it covers | Used for |
|---|---|---|---|
| Code Reviewer | `engineering-code-reviewer.md` | Correctness, maintainability, security, performance | Review before each change is accepted. Checks the invariants in the handoff |
| API Tester | `testing-api-tester.md` | API validation, third-party integration testing | Route checks against `docs/API.md`, and the OMSGuru client against its spec |
| Codebase Onboarding Engineer | `engineering-codebase-onboarding-engineer.md` | Tracing code paths, stating only what the code shows | Keeping the docs true to the code. Audits such as the UI controls audit |
| Frontend Developer | `engineering-frontend-developer.md` | React, component structure, performance | `src/pages/*`, the shared `DataTable`, the register and upload screens |

### Security, credentials and privacy

| Role | File | What it covers | Used for |
|---|---|---|---|
| Secrets & Credential Hygiene Engineer | `security-secrets-credential-engineer.md` | Secret lifecycle, vaulting, rotation, leak response | The OMSGuru token and client ID, the `.env` rules, `NEW_USER_PASSWORD` handling |
| Application Security Engineer | `security-appsec-engineer.md` | OWASP review, dependency risk | Account scope on every route, `requireAdmin`, sessions, uploads, the CORS and health-check exposure |
| Data Privacy Officer | `data-privacy-officer.md` | Privacy programmes, data mapping, retention | Customer and supplier personal data in marketplace files, the buyer-field decisions, the archive rules |

### Design

| Role | File | What it covers | Used for |
|---|---|---|---|
| UI Designer | `design-ui-designer.md` | Design systems, component libraries | The shared table and list components, the register's column chooser |
| UX Architect | `design-ux-architect.md` | Information architecture, CSS systems | Navigation, the Admin tabs, the scan and upload flows |
| Data Visualization Engineer | `engineering-data-visualization-engineer.md` | Chart choice, accessible charts | The overview and claims charts |

### Incidents and operations

| Role | File | What it covers | Used for |
|---|---|---|---|
| Incident Responder | `security-incident-responder.md` | Breach and incident response | If a credential or a customer file leaks |

## Workstreams and the roles that lead them

Use one lead per workstream. Support roles review or advise. Every workstream ends with the handback described in [agent-handoff.md](agent-handoff.md#handoff-protocol).

| Workstream | Lead | Support | What is handed back |
|---|---|---|---|
| Verification: run the typecheck, build, tests and database checks, and report each result | Platform Engineer | API Tester, Code Reviewer | The output of each command, the failures in full, and what was not run |
| Account access review: every data route scoped, every configuration route Admin-only | Application Security Engineer | Code Reviewer, Backend Architect | A route-by-route table, the tests that cover each, and any route not covered |
| Scan persistence and the register: lookup, scan save, snapshots, tickets, register queries | Backend Architect | Database Optimizer, Database Reliability Engineer, Code Reviewer | The change, its tests, and the effect on existing scans (none may change) |
| Uploads and marketplace layouts: preview, activation, header maps, number rules | Data Engineer | Backend Architect, Data Privacy Officer | The layout's evidence (the real file, its headers), the tests, and the open decisions |
| Schema changes: new tables, columns, indexes, constraints | Database Reliability Engineer | Database Optimizer | The additive SQL, its place in the schema order, and the check that it runs twice |
| Register and scan screens: controls, layout, mobile, export | Frontend Developer | UI Designer, UX Architect | The controls, each checked against the UI audit, and what was not checked in a browser |
| Administration: partners, courier names, hosts, categories, sub-issues | Backend Architect | Application Security Engineer, Frontend Developer | The audit rows each change writes, and the Admin-only check |
| OMSGuru integration: listings, SKUs, invoices, orders, throttling | API Platform Engineer | Secrets & Credential Hygiene Engineer, Application Security Engineer, API Tester | The client against its spec, and the credential handling checked |
| Privacy and retention: buyer fields, the archive, PII retention | Data Privacy Officer | Data Engineer, Database Reliability Engineer | A decision paper for the user. No code changes without the user's decision |
| Overview and claims figures and charts | Data Visualization Engineer | Frontend Developer | The figure definitions, which are proposals until the user confirms them |
| Documentation: keep `docs/` and `README.md` true to the code | Codebase Onboarding Engineer | Software Architect | The changed document, with the statement it corrects and the file that proves it |
| Credential or customer-file leak | Incident Responder | Secrets & Credential Hygiene Engineer | An incident note. Rotation is done by the user |
| Daily sync scheduling and the archive job (later) | DevOps Automator | Data Engineer, Database Reliability Engineer | A schedule definition, not run without the user's approval |
| Kotlin mobile app (not started) | Mobile App Builder | Backend Architect, Application Security Engineer, Secrets & Credential Hygiene Engineer | Nothing until the user asks. When it starts, it is a separate Kotlin client. It uses the same PostgreSQL data and the same sign-in (`POST /api/auth/login`, bearer token, scoped `requireUser`). |

## Installed and not in use

Downloaded on 2026-10-11 from github.com/msitarzewski/agency-agents, branch `main`. Each file is the upstream file, unchanged. None of these roles has been used on the app. The Kotlin mobile client is not started.

| Role | File | What it covers |
|---|---|---|
| Mobile App Builder | `engineering-mobile-app-builder.md` | Native iOS and Android, and cross-platform mobile clients. The later app is Kotlin, with the same database and the same login. |
| Senior Developer | `engineering-senior-developer.md` | Premium full-stack implementation |
| Autonomous Optimization Architect | `engineering-autonomous-optimization-architect.md` | Shadow tests and cost guardrails for automated optimisation |
| Git Workflow Master | `engineering-git-workflow-master.md` | Branching, commit history, worktrees |
| Minimal Change Engineer | `engineering-minimal-change-engineer.md` | The smallest change that does the asked work |
| Desktop App Engineer | `engineering-desktop-app-engineer.md` | Electron and Tauri desktop apps |
| UX Researcher | `design-ux-researcher.md` | Usability research and evidence for design decisions |
| UI Finish-Gate Reviewer | `design-ui-finish-gate-reviewer.md` | A last review against a written design contract |
| Test Automation Engineer | `testing-test-automation-engineer.md` | Playwright and Cypress end-to-end tests |
| Accessibility Auditor | `testing-accessibility-auditor.md` | WCAG audits and assistive-technology checks |
| Workflow Optimizer | `testing-workflow-optimizer.md` | Process bottlenecks and automation |
| Security Architect | `security-architect.md` | Threat models and the security design. Code-level review stays with the Application Security Engineer. |
| Penetration Tester | `security-penetration-tester.md` | Authorised security testing. Installing the role does not authorise a test. |

`engineering-mobile-app-builder.md` matches the upstream file byte for byte, including a broken character in two section headings where an emoji was lost. The role name and the instructions are intact.

## Not needed for this app

Game, XR, blockchain, healthcare, music, Salesforce, and marketing roles, plus the `gsd-*` helpers (those belong to the GSD workflow). They are not copied into this project.

## How to use them

1. Name the role when you ask for the work, for example "use the Code Reviewer on this change". The matching file in `.claude/agents/` supplies the role's instructions.
2. Start with [AGENTS.md](../../AGENTS.md) and the handoff. A role is not a shortcut around them.
3. For a change to the scan or import, use the Backend Architect or the Data Engineer, and the Code Reviewer.
4. For the OMSGuru integration, use the API Platform Engineer, the Secrets & Credential Hygiene Engineer, and the Application Security Engineer.
5. For the archive design, use the Data Engineer, the Database Reliability Engineer, and the Data Privacy Officer.
6. When work passes from one role to another, the outgoing role writes the handback in the handoff's session log, and names what the next role must not change.
7. The 13 roles under [Installed and not in use](#installed-and-not-in-use) stay unused until the user asks. Do not start the Kotlin mobile app from the Mobile App Builder file.
