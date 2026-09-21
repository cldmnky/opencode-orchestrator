import { z } from "zod"
import { VERIFICATION_DIGEST_PATTERN, VERIFICATION_LABEL_MAX_LENGTH } from "../../core/verification.js"
import { stableProjectID, type LocationLike, type StorageLike } from "../goal/state.js"
import { leadBoardProjectPrefix, parseLeadBoard } from "../orchestration/lead-board.js"

export const VERIFICATION_RECORD_VERSION = 1
export const VERIFICATION_MAX_RECEIPTS_PER_SESSION = 64
export const VERIFICATION_RECEIPT_ID_MAX_LENGTH = 64
export const VERIFICATION_SESSION_ID_MAX_LENGTH = 512
export const VERIFICATION_AGENT_ID_MAX_LENGTH = 128
export const VERIFICATION_MESSAGE_ID_MAX_LENGTH = 512

const shaPattern = z.string().regex(VERIFICATION_DIGEST_PATTERN)
const gitShaPattern = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)

export const verificationReceiptSchema = z
  .object({
    version: z.literal(VERIFICATION_RECORD_VERSION),
    receiptID: z.string().min(1).max(VERIFICATION_RECEIPT_ID_MAX_LENGTH),
    rootSessionID: z.string().min(1).max(VERIFICATION_SESSION_ID_MAX_LENGTH),
    sessionID: z.string().min(1).max(VERIFICATION_SESSION_ID_MAX_LENGTH),
    agentID: z.string().min(1).max(VERIFICATION_AGENT_ID_MAX_LENGTH),
    messageID: z.string().min(1).max(VERIFICATION_MESSAGE_ID_MAX_LENGTH),
    commandDigest: shaPattern,
    commandLabel: z.string().min(1).max(VERIFICATION_LABEL_MAX_LENGTH),
    status: z.enum(["pass", "fail"]),
    exitCode: z.number().int().min(0),
    startedAt: z.number().finite().nonnegative(),
    completedAt: z.number().finite().nonnegative(),
    repository: z
      .object({
        rootDigest: shaPattern,
        headSha: gitShaPattern,
      })
      .strict(),
  })
  .strict()

export type VerificationReceiptV1 = z.infer<typeof verificationReceiptSchema>

export function verificationProjectPrefix(projectID: string, rootSessionID: string): string {
  return `verification/v1/${encodeURIComponent(projectID)}/${encodeURIComponent(rootSessionID)}/`
}

export function verificationStorageKey(projectID: string, rootSessionID: string, receiptID: string): string {
  return `${verificationProjectPrefix(projectID, rootSessionID)}${encodeURIComponent(receiptID)}`
}

export async function verificationKeyedProjectID(storage: StorageLike, location: LocationLike, sessionID: string): Promise<string> {
  return stableProjectID(storage, location, sessionID)
}

export function parseVerificationReceipt(value: unknown): VerificationReceiptV1 | undefined {
  const parsed = verificationReceiptSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export async function readVerificationReceipt(
  storage: StorageLike,
  location: LocationLike,
  rootSessionID: string,
  receiptID: string,
): Promise<VerificationReceiptV1 | undefined> {
  const projectID = await verificationKeyedProjectID(storage, location, rootSessionID)
  try {
    const receipt = parseVerificationReceipt(await storage.get(verificationStorageKey(projectID, rootSessionID, receiptID)))
    return receipt?.receiptID === receiptID && receipt.rootSessionID === rootSessionID ? receipt : undefined
  } catch {
    return undefined
  }
}

export async function listVerificationReceipts(
  storage: StorageLike,
  location: LocationLike,
  rootSessionID: string,
  receiptIDs?: readonly string[],
): Promise<VerificationReceiptV1[]> {
  const projectID = await verificationKeyedProjectID(storage, location, rootSessionID)
  const prefix = verificationProjectPrefix(projectID, rootSessionID)
  const wanted = receiptIDs ? [...new Set(receiptIDs)] : undefined
  const receipts: VerificationReceiptV1[] = []

  // Receipt-ID lookups do not require scan support and are the normal
  // validation path. The exact key and duplicated identity fields are both
  // checked before a value is returned.
  if (wanted) {
    for (const receiptID of wanted.slice(0, VERIFICATION_MAX_RECEIPTS_PER_SESSION)) {
      const receipt = await readVerificationReceipt(storage, location, rootSessionID, receiptID)
      if (receipt) receipts.push(receipt)
    }
    return sortReceipts(receipts)
  }

  const scan = storage.scan
  if (!scan) return []
  let after: string | undefined
  for (let page = 0; page < 8; page += 1) {
    const result = await scan({ prefix, ...(after ? { after } : {}), limit: VERIFICATION_MAX_RECEIPTS_PER_SESSION + 1 })
    for (const entry of result.entries) {
      const receipt = parseVerificationReceipt(entry.value)
      if (!receipt) continue
      if (receipt.rootSessionID !== rootSessionID) continue
      if (entry.key !== verificationStorageKey(projectID, rootSessionID, receipt.receiptID)) continue
      receipts.push(receipt)
    }
    if (!result.next) break
    after = result.next
  }
  return sortReceipts(receipts)
}

function sortReceipts(receipts: VerificationReceiptV1[]): VerificationReceiptV1[] {
  return receipts.sort((a, b) => a.completedAt - b.completedAt || a.receiptID.localeCompare(b.receiptID))
}

export async function writeVerificationReceipt(
  storage: StorageLike,
  location: LocationLike,
  receipt: VerificationReceiptV1,
): Promise<void> {
  if (!verificationReceiptSchema.safeParse(receipt).success) throw new Error("invalid verification receipt")
  const projectID = await verificationKeyedProjectID(storage, location, receipt.rootSessionID)
  await storage.set(verificationStorageKey(projectID, receipt.rootSessionID, receipt.receiptID), receipt)
}

export async function evictVerificationReceipts(
  storage: StorageLike,
  location: LocationLike,
  rootSessionID: string,
  protectedReceiptIDs?: ReadonlySet<string>,
): Promise<void> {
  // If the caller cannot inspect active board references, retaining receipts
  // is the fail-closed choice. Runtime callers pass the result of
  // activeBoardVerificationReceiptIDs below.
  if (!protectedReceiptIDs) return
  const receipts = await listVerificationReceipts(storage, location, rootSessionID)
  if (receipts.length <= VERIFICATION_MAX_RECEIPTS_PER_SESSION) return
  const projectID = await verificationKeyedProjectID(storage, location, rootSessionID)
  const removable = receipts.filter((receipt) => !protectedReceiptIDs.has(receipt.receiptID))
  const remove = removable.slice(0, Math.max(0, receipts.length - VERIFICATION_MAX_RECEIPTS_PER_SESSION))
  for (const receipt of remove) {
    await storage.remove(verificationStorageKey(projectID, rootSessionID, receipt.receiptID))
  }
}

/**
 * Returns receipt IDs referenced by active V1 lead-board validations. An
 * unavailable scan or malformed board is `undefined`, which tells eviction to
 * retain every receipt rather than risk deleting active proof.
 */
export async function activeBoardVerificationReceiptIDs(
  storage: StorageLike,
  location: LocationLike,
  rootSessionID: string,
): Promise<ReadonlySet<string> | undefined> {
  const scan = storage.scan
  if (!scan) return undefined
  const projectID = await verificationKeyedProjectID(storage, location, rootSessionID)
  const prefix = leadBoardProjectPrefix(projectID)
  const receiptIDs = new Set<string>()
  let after: string | undefined
  try {
    for (let page = 0; page < 8; page += 1) {
      const result = await scan({ prefix, ...(after ? { after } : {}), limit: 128 })
      for (const entry of result.entries) {
        const board = parseLeadBoard(entry.value)
        if (!board) return undefined
        if (board.status !== "active" || board.leadSessionID !== rootSessionID) continue
        for (const task of board.tasks) {
          for (const receiptID of task.validation?.receiptIDs ?? []) receiptIDs.add(receiptID)
        }
      }
      if (!result.next) return receiptIDs
      after = result.next
    }
  } catch {
    return undefined
  }
  return undefined
}
