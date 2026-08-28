/**
 * Central package/distribution identity shared by core, the installer, doctor,
 * CLI, and the plugin's error surfaces. These are pure constants (no filesystem
 * or process concerns) so every layer can import them safely.
 *
 * There are deliberately two distinct names:
 * - The npm distribution / CLI binary name (`DISTRIBUTION_NAME`), which can be
 *   renamed as the package evolves.
 * - The stable runtime plugin ID (`RUNTIME_PLUGIN_ID`) registered in the V2
 *   host. It must never change because it is the identity OpenCode persists and
 *   reports.
 *
 * `LEGACY_DISTRIBUTION_NAME` is the exact name this package shipped under
 * before the current rename. Existing project configs may still reference it as
 * a bare plugin entry, and the installer/doctor treat it as legacy/ambiguous
 * migration input.
 *
 * `SCOPED_DISTRIBUTION_NAME` is the scoped spelling of the current distribution
 * name. Recognizing it as this plugin does not imply that it is published; it
 * is accepted so scoped installs resolve to the same plugin.
 */
export const DISTRIBUTION_NAME = "opencode-v2-agent-orchestrator"

/** The plugin ID registered in the V2 host. Independent of the package name; never change. */
export const RUNTIME_PLUGIN_ID = "opencode-orchestrator"

/** The exact name used before this rename; legacy/ambiguous bare config entries use it. */
export const LEGACY_DISTRIBUTION_NAME = "opencode-orchestrator"

/**
 * Scoped spelling of the current distribution name. Recognition by doctor and
 * the installer does not imply publication.
 */
export const SCOPED_DISTRIBUTION_NAME = "@cldmnky/opencode-v2-agent-orchestrator"
