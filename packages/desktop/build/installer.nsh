!macro stopHermesStudioProcesses
  hermesStudioStopRetry:
    DetailPrint "Stopping Hermes Studio..."
    IfFileExists "$INSTDIR\Hermes Studio.exe" 0 hermesStudioSkipQuitSignal
      nsExec::ExecToLog '"$INSTDIR\Hermes Studio.exe" --quit'
      Pop $0
  hermesStudioSkipQuitSignal:

    InitPluginsDir
    FileOpen $0 "$PLUGINSDIR\stop-hermes-studio.ps1" w
    FileWrite $0 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
    FileWrite $0 "$$target = [System.IO.Path]::GetFullPath($$env:HERMES_STUDIO_EXE)$\r$\n"
    FileWrite $0 "$$targets = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)$\r$\n"
    FileWrite $0 "function Add-HermesStudioPath {$\r$\n"
    FileWrite $0 "  param([string]$$Path)$\r$\n"
    FileWrite $0 "  if ([string]::IsNullOrWhiteSpace($$Path)) { return }$\r$\n"
    FileWrite $0 "  $$candidate = $$Path.Trim().Trim('$\"')$\r$\n"
    FileWrite $0 "  if (-not $$candidate) { return }$\r$\n"
    FileWrite $0 "  try { $$full = [System.IO.Path]::GetFullPath($$candidate) } catch { $$full = $$candidate }$\r$\n"
    FileWrite $0 "  $$name = [System.IO.Path]::GetFileName($$full)$\r$\n"
    FileWrite $0 "  if ($$name -ieq 'Uninstall Hermes Studio.exe') { $$full = Join-Path ([System.IO.Path]::GetDirectoryName($$full)) 'Hermes Studio.exe'; $$name = 'Hermes Studio.exe' }$\r$\n"
    FileWrite $0 "  if ($$name -ine 'Hermes Studio.exe') { return }$\r$\n"
    FileWrite $0 "  $$null = $$targets.Add($$full)$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "function Resolve-HermesStudioPathFromCommand {$\r$\n"
    FileWrite $0 "  param([string]$$Command)$\r$\n"
    FileWrite $0 "  if ([string]::IsNullOrWhiteSpace($$Command)) { return $$null }$\r$\n"
    FileWrite $0 "  $$trimmed = $$Command.Trim()$\r$\n"
    FileWrite $0 "  if ($$trimmed.StartsWith('$\"')) {$\r$\n"
    FileWrite $0 "    $$end = $$trimmed.IndexOf('$\"', 1)$\r$\n"
    FileWrite $0 "    if ($$end -gt 1) { return $$trimmed.Substring(1, $$end - 1) }$\r$\n"
    FileWrite $0 "  }$\r$\n"
    FileWrite $0 "  foreach ($$marker in @('Hermes Studio.exe', 'Uninstall Hermes Studio.exe')) {$\r$\n"
    FileWrite $0 "    $$index = $$trimmed.IndexOf($$marker, [System.StringComparison]::OrdinalIgnoreCase)$\r$\n"
    FileWrite $0 "    if ($$index -ge 0) { return $$trimmed.Substring(0, $$index + $$marker.Length).Trim().Trim('$\"') }$\r$\n"
    FileWrite $0 "  }$\r$\n"
    FileWrite $0 "  return $$null$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "function Add-HermesStudioCommandPath {$\r$\n"
    FileWrite $0 "  param([string]$$Command)$\r$\n"
    FileWrite $0 "  Add-HermesStudioPath (Resolve-HermesStudioPathFromCommand $$Command)$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "function Add-HermesStudioRegistryPaths {$\r$\n"
    FileWrite $0 "  $$uninstallRoots = @($\r$\n"
    FileWrite $0 "    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',$\r$\n"
    FileWrite $0 "    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',$\r$\n"
    FileWrite $0 "    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'$\r$\n"
    FileWrite $0 "  )$\r$\n"
    FileWrite $0 "  Get-ItemProperty $$uninstallRoots -ErrorAction SilentlyContinue | Where-Object {$\r$\n"
    FileWrite $0 "    [string]$$_.DisplayName -like '*Hermes Studio*' -or [string]$$_.DisplayIcon -like '*Hermes Studio*' -or [string]$$_.UninstallString -like '*Hermes Studio*'$\r$\n"
    FileWrite $0 "  } | ForEach-Object {$\r$\n"
    FileWrite $0 "    Add-HermesStudioCommandPath ([string]$$_.DisplayIcon)$\r$\n"
    FileWrite $0 "    Add-HermesStudioCommandPath ([string]$$_.UninstallString)$\r$\n"
    FileWrite $0 "    Add-HermesStudioCommandPath ([string]$$_.QuietUninstallString)$\r$\n"
    FileWrite $0 "  }$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "function Repair-HermesStudioStartupEntry {$\r$\n"
    FileWrite $0 "  $$runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'$\r$\n"
    FileWrite $0 "  $$entry = Get-ItemProperty -Path $$runPath -ErrorAction SilentlyContinue$\r$\n"
    FileWrite $0 "  if (-not $$entry) { return }$\r$\n"
    FileWrite $0 "  $$entry.PSObject.Properties | Where-Object { $$_.Name -like '*Hermes Studio*' -or [string]$$_.Value -like '*Hermes Studio.exe*' } | ForEach-Object {$\r$\n"
    FileWrite $0 "    Add-HermesStudioCommandPath ([string]$$_.Value)$\r$\n"
    FileWrite $0 "    Set-ItemProperty -Path $$runPath -Name $$_.Name -Value ('$\"{0}$\" --hidden' -f $$target) -ErrorAction SilentlyContinue$\r$\n"
    FileWrite $0 "  }$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "function Get-HermesStudioProcess {$\r$\n"
    FileWrite $0 "  $$exeTargets = @($$targets)$\r$\n"
    FileWrite $0 "  Get-CimInstance Win32_Process | Where-Object {$\r$\n"
    FileWrite $0 "    try {$\r$\n"
    FileWrite $0 "      if (-not $$_.ExecutablePath) { return $$false }$\r$\n"
    FileWrite $0 "      $$full = [System.IO.Path]::GetFullPath($$_.ExecutablePath)$\r$\n"
    FileWrite $0 "      if ($$exeTargets -icontains $$full) { return $$true }$\r$\n"
    FileWrite $0 "      return $$false$\r$\n"
    FileWrite $0 "    } catch { $$false }$\r$\n"
    FileWrite $0 "  }$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "Add-HermesStudioPath $$target$\r$\n"
    FileWrite $0 "Add-HermesStudioRegistryPaths$\r$\n"
    FileWrite $0 "Repair-HermesStudioStartupEntry$\r$\n"
    FileWrite $0 "$$deadline = (Get-Date).AddSeconds(20)$\r$\n"
    FileWrite $0 "while ((Get-Date) -lt $$deadline) {$\r$\n"
    FileWrite $0 "  $$processes = @(Get-HermesStudioProcess)$\r$\n"
    FileWrite $0 "  if ($$processes.Count -eq 0) { exit 0 }$\r$\n"
    FileWrite $0 "  $$processes | ForEach-Object {$\r$\n"
    FileWrite $0 "    try {$\r$\n"
    FileWrite $0 "      $$process = Get-Process -Id $$_.ProcessId$\r$\n"
    FileWrite $0 "      if ($$process) { $$process.CloseMainWindow() | Out-Null }$\r$\n"
    FileWrite $0 "    } catch {}$\r$\n"
    FileWrite $0 "  }$\r$\n"
    FileWrite $0 "  Start-Sleep -Milliseconds 500$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "$$processes = @(Get-HermesStudioProcess)$\r$\n"
    FileWrite $0 "$$processIds = @($$processes | ForEach-Object { [int]$$_.ProcessId })$\r$\n"
    FileWrite $0 "$$roots = @($$processes | Where-Object { $$processIds -notcontains [int]$$_.ParentProcessId })$\r$\n"
    FileWrite $0 "if ($$roots.Count -eq 0) { $$roots = $$processes }$\r$\n"
    FileWrite $0 "$$taskkill = Join-Path ([Environment]::SystemDirectory) 'taskkill.exe'$\r$\n"
    FileWrite $0 "$$roots | ForEach-Object {$\r$\n"
    FileWrite $0 "  try {$\r$\n"
    FileWrite $0 "    $$processId = [string]$$_.ProcessId$\r$\n"
    FileWrite $0 "    & $$taskkill '/PID' $$processId '/T' '/F' | Out-Null$\r$\n"
    FileWrite $0 "  } catch {}$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "$$deadline = (Get-Date).AddSeconds(10)$\r$\n"
    FileWrite $0 "while ((Get-Date) -lt $$deadline) {$\r$\n"
    FileWrite $0 "  if (@(Get-HermesStudioProcess).Count -eq 0) { exit 0 }$\r$\n"
    FileWrite $0 "  Start-Sleep -Milliseconds 250$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "exit 1$\r$\n"
    FileClose $0

    System::Call 'kernel32::SetEnvironmentVariable(t "HERMES_STUDIO_EXE", t "$INSTDIR\Hermes Studio.exe") i .r0'
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-hermes-studio.ps1"'
    Pop $0
    System::Call 'kernel32::SetEnvironmentVariable(t "HERMES_STUDIO_EXE", t "") i .r0'
    StrCmp $0 "0" hermesStudioStopDone
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY hermesStudioStopRetry
    Quit
  hermesStudioStopDone:
!macroend

!macro customInit
  !insertmacro stopHermesStudioProcesses
!macroend

!macro customCheckAppRunning
  !insertmacro stopHermesStudioProcesses
!macroend
