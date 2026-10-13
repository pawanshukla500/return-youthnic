// Account access: which marketplace accounts a signed-in user may read or change.
//
// The rule, in order:
//  - An Admin (role "Admin", any letter case) sees every account and may change configuration.
//  - Any other user sees every account when users.has_all_marketplaces is true.
//  - Otherwise the user sees only the accounts in user_marketplaces. A user with no assignment sees nothing.
//
// Every route that reads or changes account data builds its query from these functions, so the restriction holds
// whatever the browser sends. A named account the user cannot see is refused with 403. A single return, scan or
// ticket the user cannot see is reported as not found (404), so its existence is not revealed.
//
// Pure: nothing here touches the database. The user's scope is read once per request (server/index.ts).

export type AccountScope = { all: true } | { all: false; marketplaceIds: number[] }

export const ALL_ACCOUNTS: AccountScope = { all: true }

export const NO_ACCESS_MESSAGE = "You do not have access to this account. Ask an administrator to assign it."

export function isAdminRole(role: string): boolean {
  return String(role || "").trim().toLowerCase() === "admin"
}

export function isSupervisorRole(role: string): boolean {
  return String(role || "").trim().toLowerCase() === "supervisor"
}

export function isScannerRole(role: string): boolean {
  return String(role || "").trim().toLowerCase() === "scanner"
}

export function isSupervisorOrAdminRole(role: string): boolean {
  const r = String(role || "").trim().toLowerCase()
  return r === "admin" || r === "supervisor"
}

export function scopeFor(input: { role: string; hasAllMarketplaces: boolean; marketplaceIds: number[] }): AccountScope {
  if (isAdminRole(input.role) || input.hasAllMarketplaces) return ALL_ACCOUNTS
  const ids = [...new Set(input.marketplaceIds.map((id) => Number(id)))]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b)
  return { all: false, marketplaceIds: ids }
}

export function allowsAccount(scope: AccountScope, marketplaceId: number): boolean {
  if (scope.all) return true
  return scope.marketplaceIds.includes(Number(marketplaceId))
}

// The SQL condition over one marketplace id column. A list is pushed onto params and referenced by number.
// Returns "TRUE" for every account, and "FALSE" for a user with no assignment, so such a user gets no rows at all.
export function accountCondition(scope: AccountScope, column: string, params: unknown[]): string {
  if (scope.all) return "TRUE"
  if (scope.marketplaceIds.length === 0) return "FALSE"
  params.push(scope.marketplaceIds)
  return `${column} = ANY($${params.length}::integer[])`
}

// For queries written as "($n::integer[] IS NULL OR column = ANY($n))": null means every account.
export function accountListParam(scope: AccountScope): number[] | null {
  return scope.all ? null : scope.marketplaceIds
}

// The scope a route falls back to when it has none (a test, or a call from a script). It is the narrowest scope, so a
// missing scope never widens access.
export const NO_ACCOUNTS: AccountScope = { all: false, marketplaceIds: [] }
