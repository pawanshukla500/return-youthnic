import type { JobExecutionBundle } from "./agent-client.js"

/**
 * A minimal execution bundle for a follow-up ticket check.
 *
 * A follow-up has no filing data and no evidence. It only needs the panel's saved
 * browser profile (chosen from `marketplace`) and the ticket reference, which is
 * passed to `checkClaimStatus()`. The marketplace classes read the job object only
 * inside `execute()`, which a follow-up never calls, so these placeholders are
 * never used for a decision.
 *
 * Building it here, in one tested place, keeps the worker from inventing a bundle
 * at the call site and keeps the required fields of `JobExecutionBundle` in step
 * with the type.
 */
export function followUpExecutionBundle(input: {
  claimId: number
  marketplace: string
  accountName: string
  portalUrl: string
}): JobExecutionBundle {
  return {
    jobId: 0,
    claimId: input.claimId,
    stage: "follow_up",
    marketplace: input.marketplace,
    accountName: input.accountName,
    portalUrl: input.portalUrl,
    credentials: { username: "", password: "", authState: {} },
    automationMode: "follow_up",
    requireApprovalBeforeSubmit: false,
    claim: {
      orderNumber: "",
      subOrderId: "",
      trackingId: "",
      packetId: "",
      sku: "",
      customerName: "",
      totalPrice: 0,
      claimReason: "",
      claimTitle: "",
      claimDescription: "",
      claimContent: "",
      remarks: "",
    },
    evidenceFiles: [],
  }
}
