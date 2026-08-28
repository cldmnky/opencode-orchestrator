import { z } from "zod"
import { DEFAULT_ROLES, type RoleName } from "./roles.js"

export const COMMAND_NAMES = [
  "orchestrate",
  "goal",
  "restructure",
  "run-plan",
  "halt",
  "handover",
  "polish",
  "stress-plan",
] as const

const agentId = z.string().trim().min(1)
const roleOptions = z
  .object({
    planning: agentId.default(DEFAULT_ROLES.planning),
    research: agentId.default(DEFAULT_ROLES.research),
    implementation: agentId.default(DEFAULT_ROLES.implementation),
    review: agentId.default(DEFAULT_ROLES.review),
  })
  .strict()

const commandOptions = z
  .object(
    Object.fromEntries(COMMAND_NAMES.map((name) => [name, z.boolean().optional()])) as Record<
      (typeof COMMAND_NAMES)[number],
      z.ZodOptional<z.ZodBoolean>
    >,
  )
  .strict()

export const OrchestratorOptionsSchema = z
  .object({
    orchestrator: agentId.default("orchestrator"),
    roles: roleOptions.default(DEFAULT_ROLES),
    max_parallel: z.number().int().min(1).max(8).default(4),
    require_review: z.boolean().default(true),
    strict_agents: z.boolean().default(true),
    commands: commandOptions.default({}),
    goal: z
      .object({
        auto_continue: z.boolean().default(true),
        max_continuations: z.number().int().positive().max(1000).default(50),
        cooldown_ms: z.number().int().nonnegative().default(1000),
      })
      .default({ auto_continue: true, max_continuations: 50, cooldown_ms: 1000 }),
  })
  .superRefine((value, context) => {
    const seen = new Map<string, RoleName>()
    for (const role of Object.keys(value.roles) as RoleName[]) {
      const id = value.roles[role]
      if (id === value.orchestrator) {
        context.addIssue({
          code: "custom",
          path: ["roles", role],
          message: "role agent must not be the orchestrator agent",
        })
      }
      const previous = seen.get(id)
      if (previous) {
        context.addIssue({
          code: "custom",
          path: ["roles", role],
          message: `agent ID is already assigned to role ${previous}`,
        })
      } else {
        seen.set(id, role)
      }
    }
  })

export type OrchestratorOptions = z.infer<typeof OrchestratorOptionsSchema>
export type CommandName = (typeof COMMAND_NAMES)[number]

export function parseOptions(value: unknown): OrchestratorOptions {
  const parsed = OrchestratorOptionsSchema.safeParse(value ?? {})
  if (!parsed.success) {
    throw new Error(`Invalid opencode-orchestrator options: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`)
  }

  return { ...parsed.data, roles: parsed.data.roles as Record<RoleName, string> }
}

export function isCommandEnabled(options: OrchestratorOptions, name: CommandName): boolean {
  return options.commands[name] !== false
}
