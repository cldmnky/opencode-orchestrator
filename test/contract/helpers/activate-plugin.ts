type ActivationHost = {
  session: {
    create(input: { location: { directory: string } }): Promise<{ id: string }>
    prompt(input: {
      sessionID: string
      text: string
      delivery: "queue"
      resume: false
    }): Promise<unknown>
    remove(input: { sessionID: string }): Promise<void>
  }
}

/**
 * OpenCode 2.x activates directly registered plugins lazily on the first
 * session operation for a location. Use a queued, non-resuming prompt so
 * contract tests can install hooks without waking a provider call.
 */
export async function activatePlugin(host: ActivationHost, directory: string, remove = true): Promise<string> {
  const session = await host.session.create({ location: { directory } })
  await host.session.prompt({
    sessionID: session.id,
    text: "contract plugin activation",
    delivery: "queue",
    resume: false,
  })
  if (remove) await host.session.remove({ sessionID: session.id })
  return session.id
}
