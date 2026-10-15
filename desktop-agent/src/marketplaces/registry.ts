import type { BrowserRunner } from "../browser-runner.js"
import type { JobExecutionBundle } from "../agent-client.js"
import type { BaseMarketplaceAutomation } from "./base-automation.js"
import { MeeshoAutomation } from "./meesho.js"
import { FlipkartAutomation } from "./flipkart.js"
import { MyntraAutomation } from "./myntra.js"
import { AjioAutomation } from "./ajio.js"

export function getAutomationEngine(
  marketplace: string,
  browser: BrowserRunner,
  job: JobExecutionBundle,
  evidenceFilesMap: Map<string, string>,
  workDir: string,
): BaseMarketplaceAutomation {
  const norm = marketplace.toLowerCase()

  if (norm.includes("meesho")) {
    return new MeeshoAutomation(browser, job, evidenceFilesMap, workDir)
  }
  if (norm.includes("flipkart")) {
    return new FlipkartAutomation(browser, job, evidenceFilesMap, workDir)
  }
  if (norm.includes("myntra")) {
    return new MyntraAutomation(browser, job, evidenceFilesMap, workDir)
  }
  if (norm.includes("ajio")) {
    return new AjioAutomation(browser, job, evidenceFilesMap, workDir)
  }

  // Fallback to generic Meesho-style engine
  return new MeeshoAutomation(browser, job, evidenceFilesMap, workDir)
}
