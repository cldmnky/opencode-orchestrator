import type { ProgressView } from "../opencode-v2/progress/rpc.js"

/**
 * Formats the bounded RPC projection for the read-only TUI detail dialog.
 * Nothing in this formatter reads storage or performs a mutation.
 */
export function formatProgressDetail(view: ProgressView): string {
  const lines: string[] = []
  lines.push(`Goal: ${view.goal ? `${view.goal.status} — ${view.goal.objectiveHint}` : "unknown / not initialized"}`)
  lines.push(`Board: ${view.board.status} (${view.board.completed}/${view.board.total} completed)`)
  if (view.currentTask) lines.push(`Current: ${view.currentTask.title} [${view.currentTask.role}]`)
  if (view.reservedTask) lines.push(`Reserved: ${view.reservedTask.title} [${view.reservedTask.role}]`)
  if (!view.currentTask && !view.reservedTask) lines.push("Current: unknown")

  if (view.board.tasks.length > 0) {
    lines.push("Tasks:")
    for (const task of view.board.tasks) lines.push(`- ${task.status} · ${task.role} · ${task.title}`)
    if (view.board.total > view.board.tasks.length) lines.push(`- … ${view.board.total - view.board.tasks.length} more task(s) not shown`)
  }

  lines.push(`Review: ${view.review ? `${view.review.state} (round ${view.review.round})` : "unknown / not started"}`)
  lines.push(`Budget: ${view.budget.verdict} (${view.budget.coverage})`)
  if (view.budget.limits.length > 0) {
    for (const limit of view.budget.limits) {
      const observed = limit.observed === undefined ? "unknown" : String(limit.observed)
      const configured = limit.configured === undefined ? "?" : String(limit.configured)
      lines.push(`- ${limit.limit}: ${limit.status} (${observed}/${configured})`)
    }
  }

  lines.push(`Worktree: ${view.worktree ? `${view.worktree.status} · ${view.worktree.branch}` : "unknown / not initialized"}`)
  lines.push(`Publication: ${view.publication.durableEnabled ? "enabled" : "disabled"} (${view.publication.configEnabled ? "config on" : "config off"})`)
  const enabled = view.gates.statuses.filter((status) => status.enabled).map((status) => status.gate)
  const disabled = view.gates.statuses.filter((status) => !status.enabled).map((status) => status.gate)
  lines.push(`Gates: on ${enabled.join(", ") || "none"}; off ${disabled.join(", ") || "none"}`)
  lines.push(`Completeness: ${view.complete ? "complete" : "incomplete / unknown"}`)
  if (view.limitations.length > 0) {
    lines.push("Limitations:")
    for (const limitation of view.limitations) lines.push(`- ${limitation}`)
  }
  return lines.join("\n")
}
