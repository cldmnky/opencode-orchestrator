/** Supported, side-effecting installer facade for package consumers. */
export {
  configRelativePluginReference,
  createBackup,
  defaultConfigPath,
  formatInstallDiff,
  installConfig,
  isLocalPluginReference,
  migrateConfig,
  planInstallConfig,
  pluginEntryForRuntimeFile,
} from "./cli/install.js"
export type { AgentModelReferences, InstallPlan, InstallSummary, InstallTarget } from "./cli/install.js"
