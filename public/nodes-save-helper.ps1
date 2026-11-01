# N.O.D.E.S save helper
#
# Chrome and Edge won't let websites open anything inside AppData, which is where
# Satisfactory keeps its saves. This helper copies your saves to
#   Documents\N.O.D.E.S Saves
# whenever the game writes one, so N.O.D.E.S can sync from that folder instead.
#
# Run it once (right-click > Run with PowerShell). It installs itself to start when
# you sign in to Windows and keeps running quietly in the background.
#
#   -Uninstall   stop it and remove it from startup
#   -Once        copy new saves one time and exit
#   -Watch       keep copying (what the startup shortcut runs)

param([switch]$Watch, [switch]$Once, [switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$Source = Join-Path $env:LOCALAPPDATA 'FactoryGame\Saved\SaveGames'
$Target = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'N.O.D.E.S Saves'
$Home_ = Join-Path $env:LOCALAPPDATA 'N.O.D.E.S'
$Installed = Join-Path $Home_ 'nodes-save-helper.ps1'
$Shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'N.O.D.E.S save helper.lnk'

function Stop-Helper {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*nodes-save-helper.ps1*-Watch*' -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Copy-NewSaves {
  if (-not (Test-Path $Source)) { return 0 }
  if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Path $Target | Out-Null }
  $copied = 0
  $all = Get-ChildItem -Path $Source -Filter '*.sav' -File -Recurse |
    Where-Object { $_.FullName -notmatch '\\blueprints\\' -and $_.Length -gt 1024 -and $_.Name -notlike 'ServerManager*' }
  # Only the newest 3 saves of each world are needed.
  $files = $all | Group-Object { $_.BaseName -replace '_autosave_\d+$', '' -replace '_(continue|quicksave)$', '' -replace '_\d{6}-\d{6}$', '' } |
    ForEach-Object { $_.Group | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 3 }
  $keep = @{}
  foreach ($f in $files) { $keep[$f.Name] = $true }
  Get-ChildItem -Path $Target -File | Where-Object { -not $keep.ContainsKey($_.Name) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
  foreach ($f in $files) {
    # Skip a save the game is still writing.
    if (((Get-Date) - $f.LastWriteTime).TotalSeconds -lt 3) { continue }
    $dest = Join-Path $Target $f.Name
    $d = Get-Item -LiteralPath $dest -ErrorAction SilentlyContinue
    if ($d -and $d.LastWriteTimeUtc -eq $f.LastWriteTimeUtc -and $d.Length -eq $f.Length) { continue }
    try {
      $tmp = "$dest.part"
      Copy-Item -LiteralPath $f.FullName -Destination $tmp -Force
      (Get-Item -LiteralPath $tmp).LastWriteTimeUtc = $f.LastWriteTimeUtc
      Move-Item -LiteralPath $tmp -Destination $dest -Force
      $copied++
    } catch {
      Remove-Item -LiteralPath "$dest.part" -Force -ErrorAction SilentlyContinue
    }
  }
  return $copied
}

if ($Uninstall) {
  Stop-Helper
  Remove-Item -LiteralPath $Shortcut -Force -ErrorAction SilentlyContinue
  Write-Host 'N.O.D.E.S save helper removed. Copied saves in' $Target 'were left in place.'
  return
}

if ($Once) {
  $n = Copy-NewSaves
  Write-Host "Copied $n save(s) to $Target"
  return
}

if ($Watch) {
  while ($true) {
    try { Copy-NewSaves | Out-Null } catch { }
    Start-Sleep -Seconds 5
  }
}

# No switch: install, start it now, and explain.
if (-not (Test-Path $Source)) {
  Write-Host "Couldn't find Satisfactory saves in $Source" -ForegroundColor Yellow
  Write-Host 'Start the game and save once, then run this again.'
  Read-Host 'Press Enter to close'
  return
}
New-Item -ItemType Directory -Path $Home_ -Force | Out-Null
if ($PSCommandPath -ne $Installed) { Copy-Item -LiteralPath $PSCommandPath -Destination $Installed -Force }

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($Shortcut)
$lnk.TargetPath = Join-Path $PSHOME 'powershell.exe'
$lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Installed`" -Watch"
$lnk.WindowStyle = 7
$lnk.Description = 'Copies Satisfactory saves to Documents\N.O.D.E.S Saves for N.O.D.E.S'
$lnk.Save()

$n = Copy-NewSaves
Stop-Helper
Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Installed`" -Watch" -WindowStyle Hidden

Write-Host ''
Write-Host 'N.O.D.E.S save helper is running.' -ForegroundColor Green
Write-Host "Copied $n save(s) to:"
Write-Host "  $Target" -ForegroundColor Cyan
Write-Host ''
Write-Host 'It starts with Windows and copies each new save within a few seconds.'
Write-Host 'Now open N.O.D.E.S > Progress > Connect save folder, and pick that folder.'
Write-Host ''
Write-Host 'To remove it later:  powershell -ExecutionPolicy Bypass -File' "`"$Installed`"" '-Uninstall'
Read-Host 'Press Enter to close'
