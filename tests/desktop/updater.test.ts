import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isWindowsUpdaterLockError, pendingUpdateDirectories } from '../../packages/desktop/src/main/updater-helpers'

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/')
}

function normalizeSource(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

describe('desktop updater helpers', () => {
  it('detects Squirrel locked-exe update failures', async () => {
    expect(isWindowsUpdaterLockError(new Error('Failed to uninstall old application files. Please try running the installer again.: 2'))).toBe(true)
    expect(isWindowsUpdaterLockError(new Error('Squirrel update failed with code 2'))).toBe(true)
    expect(isWindowsUpdaterLockError(new Error('network timeout'))).toBe(false)
  })

  it('includes local and roaming pending update cache directories', async () => {
    expect(pendingUpdateDirectories({
      appDataPath: 'C:\\Users\\A\\AppData\\Roaming',
      localAppData: 'C:\\Users\\A\\AppData\\Local',
      appName: 'Hermes Studio',
    }).map(normalizePath)).toEqual(expect.arrayContaining([
      'C:\\Users\\A\\AppData\\Local/Hermes Studio-updater/pending',
      'C:\\Users\\A\\AppData\\Local/hermes-studio-updater/pending',
      'C:\\Users\\A\\AppData\\Roaming/hermes-studio-updater/pending',
    ].map(normalizePath)))
  })

  it('checks on startup and from the tray without forcing an update', () => {
    const updaterSource = normalizeSource(readFileSync(resolve('packages/desktop/src/main/updater.ts'), 'utf-8'))
    const mainSource = normalizeSource(readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8'))

    expect(mainSource).toContain('checkForDesktopUpdates(true)')
    expect(updaterSource).toContain('checkForDesktopUpdates(false)')
    expect(updaterSource).toContain('autoUpdater.autoDownload = false')
    expect(updaterSource).toContain('autoUpdater.autoInstallOnAppQuit = true')
    expect(updaterSource).toContain("buttons: [t('update.download'), t('update.later')]")
    expect(updaterSource).toContain('if (response === 0) {\n    await autoUpdater.downloadUpdate()')
    expect(updaterSource).not.toContain('setInterval(')
  })

  it('stops the Windows desktop server before launching the update installer', () => {
    const updaterSource = normalizeSource(readFileSync(resolve('packages/desktop/src/main/updater.ts'), 'utf-8'))
    const mainSource = normalizeSource(readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8'))

    expect(mainSource).toContain('beforeQuitAndInstall: prepareWindowsUpdateShutdown')
    expect(mainSource).toContain("if (process.platform !== 'win32') return")
    expect(mainSource).toContain('await stopWebUiServer()')
    expect(updaterSource.indexOf('await options.beforeQuitAndInstall?.()'))
      .toBeLessThan(updaterSource.indexOf('await stopOtherWindowsAppInstances()'))
    expect(updaterSource.indexOf('await stopOtherWindowsAppInstances()'))
      .toBeLessThan(updaterSource.indexOf('autoUpdater.quitAndInstall()'))
  })

  it('uses verified process-tree termination for Windows updater cleanup', () => {
    const updaterSource = normalizeSource(readFileSync(resolve('packages/desktop/src/main/updater.ts'), 'utf-8'))
    const installerSource = normalizeSource(readFileSync(resolve('packages/desktop/build/installer.nsh'), 'utf-8'))

    expect(updaterSource).toContain("& $taskkill '/PID' $processId '/T' '/F'")
    expect(updaterSource).toContain("$processIds -notcontains [int]$_.ParentProcessId")
    expect(updaterSource).toContain('if (@(Get-HermesStudioProcess).Count -eq 0) { exit 0 }')
    expect(updaterSource).toContain('Add-HermesStudioRegistryPaths')
    expect(updaterSource).toContain('Repair-HermesStudioStartupEntry')
    expect(updaterSource).toContain("Set-ItemProperty -Path $runPath -Name $_.Name -Value")
    expect(updaterSource).not.toContain('Stop-Process -Id')

    expect(installerSource).toContain('AddSeconds(20)')
    expect(installerSource).toContain("& $$taskkill '/PID' $$processId '/T' '/F'")
    expect(installerSource).toContain('StrCmp $0 "0" hermesStudioStopDone')
    expect(installerSource).toContain('$(appCannotBeClosed)')
    expect(installerSource).toContain('Add-HermesStudioRegistryPaths')
    expect(installerSource).toContain('Repair-HermesStudioStartupEntry')
    expect(installerSource).toContain("Set-ItemProperty -Path $$runPath -Name $$_.Name -Value")
    expect(installerSource).toContain("Uninstall Hermes Studio.exe")
    expect(installerSource).toContain("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*")
    expect(installerSource).not.toContain('Stop-Process -Id')
  })
})
