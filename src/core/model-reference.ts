export type ModelReference = {
  providerID: string
  id: string
  variant?: string
}

/**
 * Parse the provider/model[#variant] spelling used by installer and runtime
 * model selection. The first slash separates the provider; model IDs may
 * contain additional slashes (for example, hosted model namespaces).
 */
export function parseModelReference(value: string): ModelReference {
  const trimmed = value.trim()
  const match = /^([^/\s#=]+)\/([^\s#=]+)(?:#([^\s#=]+))?$/.exec(trimmed)
  if (!match) throw new Error("expected provider/model[#variant]")
  return {
    providerID: match[1],
    id: match[2],
    ...(match[3] ? { variant: match[3] } : {}),
  }
}

export function formatModelReference(reference: ModelReference): string {
  return `${reference.providerID}/${reference.id}${reference.variant ? `#${reference.variant}` : ""}`
}
