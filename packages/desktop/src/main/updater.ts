import { app, dialog } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { t } from './desktop-i18n'
import { isWindowsUpdaterLockError, pendingUpdateDirectories } from './updater-helpers'

let initialized = false
let checking = false
let downloadedUpdate: UpdateDownloadedEvent | null = null
let tryingFallbackFeed = false
let recoveringPendingUpdate = false

const CLOUDFLARE_LATEST_FEED_URL = 'https://download.ekkolearnai.com/latest'
const GITHUB_LATEST_FEED_URL = 'https://github.com/EKKOLearnAI/hermes-studio/releases/latest/download'
const execFileAsync = promisify(execFile)

interface AutoUpdaterOptions {
  beforeQuitAndInstall?: () => void | Promise<void>
}

let options: AutoUpdaterOptions = {}

function configureUpdateFeed(url: string): void {
  autoUpdater.setFeedURL({
    provider: 'generic',
    url,
  })
}

async function checkForUpdatesWithFallback(): Promise<void> {
  configureUpdateFeed(CLOUDFLARE_LATEST_FEED_URL)
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.warn(`[updater] Cloudflare update feed failed, trying GitHub: ${err instanceof Error ? err.message : String(err)}`)
    tryingFallbackFeed = true
    try {
      configureUpdateFeed(GITHUB_LATEST_FEED_URL)
      await autoUpdater.checkForUpdates()
    } finally {
      tryingFallbackFeed = false
    }
  }
}

function showUpToDate(info?: UpdateInfo) {
  const version = info?.version || app.getVersion()
  dialog.showMessageBox({
    type: 'info',
    title: t('update.upToDateTitle'),
    message: t('update.upToDateMessage'),
    detail: t('update.currentVersion', { version }),
    buttons: [t('common.ok')],
  }).catch(() => undefined)
}

function showUpdateCheckFailed() {
  dialog.showMessageBox({
    type: 'error',
    title: t('update.failedTitle'),
    message: t('update.failedMessage'),
    buttons: [t('common.ok')],
  }).catch(() => undefined)
}

async function clearPendingUpdateDirectories(): Promise<void> {
  if (process.platform !== 'win32') return
  const dirs = pendingUpdateDirectories({
    appDataPath: app.getPath('appData'),
    localAppData: process.env.LOCALAPPDATA,
    appName: app.getName(),
  })
  await Promise.all(dirs.map(async dir => {
    try {
      await rm(dir, { recursive: true, force: true })
      console.warn(`[updater] cleared pending update directory: ${dir}`)
    } catch (err) {
      console.warn(`[updater] failed to clear pending update directory ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }))
}

async function recoverFailedPendingUpdate(err: unknown): Promise<void> {
  if (recoveringPendingUpdate || process.platform !== 'win32' || !isWindowsUpdaterLockError(err)) return
  recoveringPendingUpdate = true
  try {
    await clearPendingUpdateDirectories()
    downloadedUpdate = null
  } finally {
    recoveringPendingUpdate = false
  }
}

export async function stopOtherWindowsAppInstances(execPath = process.execPath, currentPid = process.pid): Promise<void> {
  if (process.platform !== 'win32') return
  const normalizedExecPath = execPath.trim()
  if (!normalizedExecPath) return
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$target = [System.IO.Path]::GetFullPath($env:HERMES_STUDIO_UPDATE_EXE)
$current = [int]$env:HERMES_STUDIO_UPDATE_PID
$targets = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
function Add-HermesStudioPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  $candidate = $Path.Trim().Trim('"')
  if (-not $candidate) { return }
  try { $full = [System.IO.Path]::GetFullPath($candidate) } catch { $full = $candidate }
  $name = [System.IO.Path]::GetFileName($full)
  if ($name -ieq 'Uninstall Hermes Studio.exe') {
    $full = Join-Path ([System.IO.Path]::GetDirectoryName($full)) 'Hermes Studio.exe'
    $name = 'Hermes Studio.exe'
  }
  if ($name -ine 'Hermes Studio.exe') { return }
  $null = $targets.Add($full)
}
function Resolve-HermesStudioPathFromCommand {
  param([string]$Command)
  if ([string]::IsNullOrWhiteSpace($Command)) { return $null }
  $trimmed = $Command.Trim()
  if ($trimmed.StartsWith('"')) {
    $end = $trimmed.IndexOf('"', 1)
    if ($end -gt 1) { return $trimmed.Substring(1, $end - 1) }
  }
  foreach ($marker in @('Hermes Studio.exe', 'Uninstall Hermes Studio.exe')) {
    $index = $trimmed.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase)
    if ($index -ge 0) { return $trimmed.Substring(0, $index + $marker.Length).Trim().Trim('"') }
  }
  return $null
}
function Add-HermesStudioCommandPath {
  param([string]$Command)
  Add-HermesStudioPath (Resolve-HermesStudioPathFromCommand $Command)
}
function Add-HermesStudioRegistryPaths {
  $uninstallRoots = @(
    'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
  )
  Get-ItemProperty $uninstallRoots -ErrorAction SilentlyContinue | Where-Object {
    [string]$_.DisplayName -like '*Hermes Studio*' -or [string]$_.DisplayIcon -like '*Hermes Studio*' -or [string]$_.UninstallString -like '*Hermes Studio*'
  } | ForEach-Object {
    Add-HermesStudioCommandPath ([string]$_.DisplayIcon)
    Add-HermesStudioCommandPath ([string]$_.UninstallString)
    Add-HermesStudioCommandPath ([string]$_.QuietUninstallString)
  }
}
function Repair-HermesStudioStartupEntry {
  $runPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
  $entry = Get-ItemProperty -Path $runPath -ErrorAction SilentlyContinue
  if (-not $entry) { return }
  $entry.PSObject.Properties | Where-Object { $_.Name -like '*Hermes Studio*' -or [string]$_.Value -like '*Hermes Studio.exe*' } | ForEach-Object {
    Add-HermesStudioCommandPath ([string]$_.Value)
    Set-ItemProperty -Path $runPath -Name $_.Name -Value ('"{0}" --hidden' -f $target) -ErrorAction SilentlyContinue
  }
}
function Get-HermesStudioProcess {
  $exeTargets = @($targets)
  Get-CimInstance Win32_Process | Where-Object {
    try {
      if ($_.ProcessId -eq $current -or -not $_.ExecutablePath) { return $false }
      $full = [System.IO.Path]::GetFullPath($_.ExecutablePath)
      if ($exeTargets -icontains $full) { return $true }
      return $false
    } catch {
      $false
    }
  }
}
Add-HermesStudioPath $target
Add-HermesStudioRegistryPaths
Repair-HermesStudioStartupEntry
Get-HermesStudioProcess | ForEach-Object {
  try {
    $process = Get-Process -Id $_.ProcessId
    if ($process) { $process.CloseMainWindow() | Out-Null }
  } catch {}
}
Start-Sleep -Milliseconds 750
$processes = @(Get-HermesStudioProcess)
$processIds = @($processes | ForEach-Object { [int]$_.ProcessId })
$roots = @($processes | Where-Object { $processIds -notcontains [int]$_.ParentProcessId })
if ($roots.Count -eq 0) { $roots = $processes }
$taskkill = Join-Path ([Environment]::SystemDirectory) 'taskkill.exe'
$roots | ForEach-Object {
  try {
    $processId = [string]$_.ProcessId
    & $taskkill '/PID' $processId '/T' '/F' | Out-Null
  } catch {}
}
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
  if (@(Get-HermesStudioProcess).Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 250
}
exit 1
`.trim()
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: {
        ...process.env,
        HERMES_STUDIO_UPDATE_EXE: normalizedExecPath,
        HERMES_STUDIO_UPDATE_PID: String(currentPid),
      },
      timeout: 30_000,
      windowsHide: true,
    })
    console.log(`[updater] stopped other ${basename(normalizedExecPath)} instances before update install`)
  } catch (err) {
    console.warn(`[updater] failed to stop other app instances before update install: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function prepareQuitAndInstall(): Promise<void> {
  try {
    await options.beforeQuitAndInstall?.()
  } catch (err) {
    console.warn(`[updater] beforeQuitAndInstall hook failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  await stopOtherWindowsAppInstances()
}

async function quitAndInstallDownloadedUpdate(): Promise<void> {
  await prepareQuitAndInstall()
  autoUpdater.quitAndInstall()
}

async function promptInstallDownloadedUpdate(info: UpdateInfo): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: t('update.readyTitle'),
    message: t('update.readyMessage', { version: info.version }),
    detail: t('update.readyDetail'),
    buttons: [t('update.restartNow'), t('update.later')],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) {
    await quitAndInstallDownloadedUpdate()
  }
}

async function promptDownloadAvailableUpdate(info: UpdateInfo): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: t('update.availableTitle'),
    message: t('update.availableMessage', { version: info.version }),
    detail: t('update.availableDetail'),
    buttons: [t('update.download'), t('update.later')],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) {
    await autoUpdater.downloadUpdate()
  }
}

export function initAutoUpdater(nextOptions: AutoUpdaterOptions = {}) {
  options = { ...options, ...nextOptions }
  if (initialized) return
  initialized = true

  if (!app.isPackaged) return // dev mode: skip

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', info => {
    console.log(`[updater] update available: ${info.version}`)
    promptDownloadAvailableUpdate(info).catch(err => {
      console.error('[updater] update download failed:', err)
      showUpdateCheckFailed()
    })
  })
  autoUpdater.on('update-not-available', info => {
    console.log('[updater] up to date')
    if (checking) showUpToDate(info)
  })
  autoUpdater.on('error', err => {
    console.error('[updater] error:', err)
    recoverFailedPendingUpdate(err).catch(cleanupErr => {
      console.warn(`[updater] pending update recovery failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
    })
    if (checking && !tryingFallbackFeed) showUpdateCheckFailed()
  })
  autoUpdater.on('download-progress', (info: ProgressInfo) => {
    console.log(`[updater] download ${Math.round(info.percent)}%`)
  })
  autoUpdater.on('update-downloaded', async (info: UpdateDownloadedEvent) => {
    downloadedUpdate = info
    await promptInstallDownloadedUpdate(info)
  })

  if (process.env.HERMES_DESKTOP_ENABLE_AUTO_UPDATE !== 'false') {
    checkForDesktopUpdates(false).catch(err => {
      console.error('[updater] initial check failed:', err)
    })
  }
}

export async function checkForDesktopUpdates(manual: boolean): Promise<void> {
  if (!app.isPackaged) {
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        title: t('update.checkingTitle'),
        message: t('update.packagedOnlyMessage'),
        buttons: [t('common.ok')],
      })
    }
    return
  }

  if (downloadedUpdate) {
    if (manual) await promptInstallDownloadedUpdate(downloadedUpdate)
    return
  }

  if (manual) {
    await dialog.showMessageBox({
      type: 'info',
      title: t('update.checkingTitle'),
      message: t('update.checkingMessage'),
      buttons: [t('common.ok')],
    })
  }

  checking = manual
  try {
    await checkForUpdatesWithFallback()
  } catch (err) {
    if (manual) showUpdateCheckFailed()
    throw err
  } finally {
    checking = false
  }
}
