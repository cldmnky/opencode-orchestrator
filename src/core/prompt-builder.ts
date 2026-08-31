export type OrchestrationPromptInput = { objective: string; clarifyEnabled?: boolean }

const COORDINATION_LINE =
  "Coordinate this task end to end. Start with repository facts, delegate independent work in parallel only with exact disjoint write scopes, integrate the results, and verify the final state directly."

const CLARIFICATION_SECTION = [
  "",
  "Clarify ambiguous objectives before decomposing:",
  "When the objective is ambiguous, use the native ask tool to ask the user a small number of targeted clarifying questions with concrete answer options.",
  "Skip asking when the objective is already precise.",
  "Record the user's answers and incorporate them into the plan.",
  "Never ask what repository facts can answer; gather facts first.",
]

export function buildOrchestrationPrompt(input: OrchestrationPromptInput): string {
  const objective = input.objective.trim()
  const sections = [
    COORDINATION_LINE,
    "",
    `Task: ${objective.length > 0 ? objective : "(no arguments)"}`,
    "",
    "Gather repository facts before decomposition and separate established facts from assumptions.",
  ]
  if (input.clarifyEnabled === true) sections.push(...CLARIFICATION_SECTION)
  return sections.join("\n")
}