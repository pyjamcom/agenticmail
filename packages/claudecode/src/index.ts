/**
 * Public API for @agenticmail/claudecode.
 *
 * This file is the entry point named in package.json's `main` and is what the
 * agenticmail top-level CLI imports from when running `agenticmail claudecode`.
 *
 * Everything is re-exported as named exports — there is no default export.
 * Programmatic consumers can do:
 *
 *   import { install, uninstall, status } from '@agenticmail/claudecode';
 *
 * …and ignore the bundled CLI binary entirely.
 */

export { install } from './install.js';
export { uninstall, type UninstallOptions } from './uninstall.js';
export { status } from './status.js';
export { resolveConfig, type ResolveConfigOptions } from './config.js';
export { listAccounts, getAccountByName, ensureAccount, deleteAccount, checkApiHealth, AgenticMailApiError } from './api.js';
export { renderSubagentMarkdown, MANAGED_BY_MARKER } from './subagent-template.js';
export { createIntegrationRoutes } from './http-routes.js';
export { Dispatcher, type DispatcherOptions, type QueryFn } from './dispatcher.js';
export {
  resolveDispatcherTuning,
  writeDispatcherTuning,
  defaultDispatcherConfigPath,
  type DispatcherTuning,
} from './dispatcher-tuning.js';
export { loadPersonaForAgent, type LoadPersonaOptions, type LoadedPersona } from './persona-loader.js';
export { renderPersonaBody } from './subagent-template.js';
export type {
  AgenticMailAccount,
  ClaudeCodeIntegrationConfig,
  InstallResult,
  InstallStatus,
  UninstallResult,
} from './types.js';
