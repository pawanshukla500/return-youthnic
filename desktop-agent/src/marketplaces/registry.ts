import type { SupplierBrowserApi } from "../browser-adapter.js"
import type { JobExecutionBundle } from "../agent-client.js"
import type { BaseMarketplaceAutomation } from "./base-automation.js"
import { MeeshoAutomation } from "./meesho.js"
import { FlipkartAutomation } from "./flipkart.js"
import { AmazonAutomation } from "./amazon.js"
import { MyntraAutomation } from "./myntra.js"
import { AjioAutomation } from "./ajio.js"

const SUPPORTED_MARKETPLACE_KEYS = ["meesho", "flipkart", "amazon", "myntra", "ajio"] as const

/** True when a marketplace has an automation entry. Lets callers skip opening a browser for unknown panels. */
export function isMarketplaceSupported(marketplace: string): boolean {
  const norm = marketplace.toLowerCase()
  return SUPPORTED_MARKETPLACE_KEYS.some((key) => norm.includes(key))
}

export function getAutomationEngine(
  marketplace: string,
  browser: SupplierBrowserApi,
  job: JobExecutionBundle,
  evidenceFilesMap: Map<string, string[]>,
  workDir: string,
): BaseMarketplaceAutomation {
  const norm = marketplace.toLowerCase()

  if (norm.includes("meesho")) {
    return new MeeshoAutomation(browser, job, evidenceFilesMap, workDir)
  }
  if (norm.includes("flipkart")) {
    return new FlipkartAutomation(browser, job, evidenceFilesMap, workDir)
  }
  if (norm.includes("amazon")) {
    return new AmazonAutomation(browser, job, evidenceFilesMap, workDir)
  }
  if (norm.includes("myntra")) {
    return new MyntraAutomation(browser, job, evidenceFilesMap, workDir)
  }
  if (norm.includes("ajio")) {
    return new AjioAutomation(browser, job, evidenceFilesMap, workDir)
  }

  throw new Error(`Marketplace automation is not enabled for ${marketplace}. Use assisted manual filing.`)
}
