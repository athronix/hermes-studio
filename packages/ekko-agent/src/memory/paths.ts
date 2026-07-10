import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface EkkoDataPathOptions {
  webUiHome?: string
  env?: Record<string, string | undefined>
  homeDir?: string
}

export function resolveEkkoDataDirectory(options: EkkoDataPathOptions = {}): string {
  const env = options.env ?? process.env
  const configuredHome = options.webUiHome || env.HERMES_WEB_UI_HOME?.trim() || env.HERMES_WEBUI_STATE_DIR?.trim()
  const webUiHome = configuredHome ? resolve(configuredHome) : join(options.homeDir || homedir(), '.hermes-web-ui')
  return join(webUiHome, 'ekko')
}

export function resolveEkkoDatabasePath(options: EkkoDataPathOptions = {}): string {
  return join(resolveEkkoDataDirectory(options), 'ekko.db')
}
