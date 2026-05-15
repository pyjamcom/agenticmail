/**
 * Public API for @agenticmail/codex.
 *
 * Entry point named in package.json's `main`; consumed by the top-level
 * agenticmail CLI when running `agenticmail codex`, and importable
 * directly:
 *
 *   import { install, uninstall, status } from '@agenticmail/codex';
 */

export { install } from './install.js';
export { uninstall, type UninstallOptions } from './uninstall.js';
export { status } from './status.js';
export { resolveConfig, resolveCodexHome, type ResolveConfigOptions } from './config.js';
export {
  listAccounts,
  getAccountByName,
  ensureAccount,
  deleteAccount,
  checkApiHealth,
  AgenticMailApiError,
} from './api.js';
export { renderSubagentToml, renderPersonaBody, MANAGED_BY_MARKER } from './subagent-template.js';
export { createIntegrationRoutes } from './http-routes.js';
export { Dispatcher, type DispatcherOptions, type QueryFn } from './dispatcher.js';
export { loadPersonaForAgent, type LoadPersonaOptions, type LoadedPersona } from './persona-loader.js';
export type {
  AgenticMailAccount,
  CodexIntegrationConfig,
  InstallResult,
  InstallStatus,
  UninstallResult,
} from './types.js';
