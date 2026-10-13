// Account access rules, without a database. These checks run in every environment, so the restriction is tested even when
// TEST_DATABASE_URL is not set. The database checks are in access-db.test.ts.

import { test } from "node:test"
import assert from "node:assert/strict"
import type { NextFunction, Request, Response } from "express"
import {
  ALL_ACCOUNTS,
  NO_ACCESS_MESSAGE,
  NO_ACCOUNTS,
  accountCondition,
  accountListParam,
  allowsAccount,
  isAdminRole,
  scopeFor,
} from "../access.js"
import { requireAdmin, sendError } from "../http.js"
import { ServiceError, buildRegisterWhere, sortClauseFor } from "../register-service.js"

test("[synthetic] an Admin sees every account, whatever the letter case of the role", () => {
  assert.equal(isAdminRole("Admin"), true)
  assert.equal(isAdminRole("ADMIN"), true)
  assert.equal(isAdminRole("  admin "), true)
  assert.equal(isAdminRole("Scanner"), false)
  assert.equal(isAdminRole(""), false)
  assert.deepEqual(scopeFor({ role: "admin", hasAllMarketplaces: false, marketplaceIds: [] }), ALL_ACCOUNTS)
})

test("[synthetic] a user flagged for all accounts sees every account", () => {
  assert.deepEqual(scopeFor({ role: "Scanner", hasAllMarketplaces: true, marketplaceIds: [] }), ALL_ACCOUNTS)
  assert.equal(allowsAccount(ALL_ACCOUNTS, 999), true)
})

test("[synthetic] an assigned user sees only the assigned accounts, with duplicates and bad ids removed", () => {
  const scope = scopeFor({ role: "Scanner", hasAllMarketplaces: false, marketplaceIds: [3, 1, 3, 0, -2, Number.NaN] })
  assert.deepEqual(scope, { all: false, marketplaceIds: [1, 3] })
  assert.equal(allowsAccount(scope, 1), true)
  assert.equal(allowsAccount(scope, 2), false)
})

test("[synthetic] a user with no assignment sees nothing", () => {
  const scope = scopeFor({ role: "Scanner", hasAllMarketplaces: false, marketplaceIds: [] })
  assert.deepEqual(scope, { all: false, marketplaceIds: [] })
  assert.equal(allowsAccount(scope, 1), false)
  const params: unknown[] = []
  assert.equal(accountCondition(scope, "m.id", params), "FALSE")
  assert.deepEqual(params, [])
  assert.deepEqual(accountListParam(scope), [])
  assert.ok(NO_ACCESS_MESSAGE.length > 0)
})

test("[synthetic] the account list is a bound parameter, never text in the SQL", () => {
  const scope = scopeFor({ role: "Scanner", hasAllMarketplaces: false, marketplaceIds: [2, 4] })
  const params: unknown[] = []
  assert.equal(accountCondition(scope, "er.marketplace_id", params), "er.marketplace_id = ANY($1::integer[])")
  assert.deepEqual(params, [[2, 4]])
  assert.equal(accountCondition(ALL_ACCOUNTS, "er.marketplace_id", []), "TRUE")
  assert.equal(accountListParam(ALL_ACCOUNTS), null)
})

test("[synthetic] Myntra EJ and Myntra VB are separate accounts: a user of one cannot use the other", () => {
  // Synthetic ids. The real reference rows are used in access-db.test.ts.
  const ej = 1
  const vb = 2
  const scope = scopeFor({ role: "Scanner", hasAllMarketplaces: false, marketplaceIds: [ej] })
  assert.equal(allowsAccount(scope, ej), true)
  assert.equal(allowsAccount(scope, vb), false)
})

test("[synthetic] a restricted user's register query is limited in SQL, and its filters can only narrow it", () => {
  const scope = scopeFor({ role: "Scanner", hasAllMarketplaces: false, marketplaceIds: [2] })
  const where = buildRegisterWhere({ marketplaceId: 9, tracking: "SYN", dateFrom: "2026-01-01" }, scope)
  assert.match(where.sql, /^ WHERE r\.marketplace_id = ANY\(\$1::integer\[\]\) AND r\.marketplace_id = \$2/)
  assert.deepEqual(where.params[0], [2])
  assert.equal(where.params[1], 9)
  assert.equal(where.sql.includes("SYN"), false, "values are parameters, not SQL text")
})

test("[synthetic] a user with no access gets a register query with no rows", () => {
  const where = buildRegisterWhere({}, NO_ACCOUNTS)
  assert.equal(where.sql, " WHERE FALSE")
  assert.deepEqual(where.params, [])
})

test("[synthetic] a sort key from the browser cannot change the SQL", () => {
  const clause = sortClauseFor("tracking_id; DROP TABLE users", "sideways")
  assert.equal(clause.includes("DROP"), false)
  assert.match(clause, /^ ORDER BY r\.scanned_at DESC/)
  assert.match(sortClauseFor("tracking_id", "asc"), /^ ORDER BY r\.tracking_id ASC/)
})

test("[synthetic] an empty ticketStatus filter does not add a ticket_statuses clause", () => {
  // Regression guard: an empty string must not become ANY($n::text[]) with $n = ''.
  const scope = scopeFor({ role: "Scanner", hasAllMarketplaces: false, marketplaceIds: [2] })
  const where = buildRegisterWhere({ ticketStatus: "" }, scope)
  assert.equal(where.sql.includes("ticket_statuses"), false, `empty ticketStatus must not add a clause; got: ${where.sql}`)
})

test("[synthetic] a non-empty ticketStatus filter adds a ticket_statuses clause", () => {
  const scope = scopeFor({ role: "Scanner", hasAllMarketplaces: false, marketplaceIds: [2] })
  const where = buildRegisterWhere({ ticketStatus: "Raised" }, scope)
  assert.match(where.sql, /\$\d+::text = ANY\(r\.ticket_statuses\)/)
  assert.equal(where.params[where.params.length - 1], "Raised")
})

// A stand-in for the Express request and response, enough to see what requireAdmin does.
function runAdminCheck(role: string): { status: number; passed: boolean } {
  const outcome = { status: 200, passed: false }
  const req = { user: { id: 1, name: "SYN", role, scope: ALL_ACCOUNTS } } as unknown as Request
  const res = {
    status(code: number) {
      outcome.status = code
      return this
    },
    json() {
      return this
    },
  } as unknown as Response
  const next: NextFunction = () => {
    outcome.passed = true
  }
  requireAdmin(req, res, next)
  return outcome
}

test("[synthetic] requireAdmin lets an Admin through and refuses every other role with 403", () => {
  assert.deepEqual(runAdminCheck("Admin"), { status: 200, passed: true })
  assert.deepEqual(runAdminCheck("Scanner"), { status: 403, passed: false })
  assert.deepEqual(runAdminCheck(""), { status: 403, passed: false })
})

test("[synthetic] a ServiceError keeps its HTTP status and message; any other error goes to the error handler", () => {
  const sent: { status?: number; body?: unknown } = {}
  const res = {
    status(code: number) {
      sent.status = code
      return this
    },
    json(body: unknown) {
      sent.body = body
      return this
    },
  } as unknown as Response
  const forwarded: { error?: unknown } = {}
  const next: NextFunction = (error?: unknown) => {
    forwarded.error = error
  }
  sendError(res, new ServiceError(404, "Return not found"), next)
  assert.equal(sent.status, 404)
  assert.deepEqual(sent.body, { error: "Return not found", details: [] })
  // Read into a separate value: asserting on forwarded.error here would narrow the property to undefined, which
  // makes the instanceof check below invalid to the compiler.
  const firstForwarded: unknown = forwarded.error
  assert.equal(firstForwarded, undefined)
  sendError(res, new Error("boom"), next)
  assert.ok(forwarded.error instanceof Error)
})
