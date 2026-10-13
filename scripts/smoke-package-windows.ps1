param([ValidatePattern('^[A-Za-z0-9_-]+$')][string]$EvidenceName = 'package-smoke')
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$package = Join-Path $workspace 'release\AgentPlatform-win32-x64'
$executable = Join-Path $package 'AgentPlatform.exe'
$evidence = Join-Path (Join-Path $workspace 'phase1-8-evidence') $EvidenceName
if (-not (Test-Path -LiteralPath $executable)) { throw 'Packaged executable missing.' }
if (Test-Path -LiteralPath $evidence) { throw 'Smoke evidence already exists; refusing to reuse it.' }
New-Item -ItemType Directory -Path $evidence | Out-Null
$isolatedAppData = Join-Path $evidence 'appdata'
$isolatedLocalAppData = Join-Path $evidence 'localappdata'
New-Item -ItemType Directory -Path $isolatedAppData, $isolatedLocalAppData | Out-Null
$oldAppData = $env:APPDATA
$oldLocalAppData = $env:LOCALAPPDATA
$oldUserDataOverride = $env:AGENTPLATFORM_USER_DATA_DIR
$started = @()
$rendererChecks = @()

function Stop-SmokeProcess([int]$processId) {
  $parent = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $parent) { return }
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$processId" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId)
  if ($parent.MainWindowHandle -ne 0) {
    [void]$parent.CloseMainWindow()
    [void]$parent.WaitForExit(5000)
  }
  if (-not $parent.HasExited) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
  foreach ($child in $children) {
    if (Get-Process -Id $child -ErrorAction SilentlyContinue) { Stop-Process -Id $child -Force -ErrorAction SilentlyContinue }
  }
}

try {
  $env:APPDATA = $isolatedAppData
  $env:LOCALAPPDATA = $isolatedLocalAppData
  $env:AGENTPLATFORM_USER_DATA_DIR = Join-Path $evidence 'user-data'
  $databasePath = $null
  for ($round = 1; $round -le 2; $round++) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $stdout = Join-Path $evidence "launch-$round-stdout.log"
    $stderr = Join-Path $evidence "launch-$round-stderr.log"
    $process = Start-Process -FilePath $executable -ArgumentList @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$port") -WorkingDirectory $package -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $started += $process.Id
    $deadline = (Get-Date).AddSeconds(25)
    do {
      Start-Sleep -Milliseconds 250
      $process.Refresh()
      if ($process.HasExited) { throw "Packaged app exited during launch $round with code $($process.ExitCode)." }
      $candidate = Get-ChildItem -LiteralPath $env:AGENTPLATFORM_USER_DATA_DIR -Filter agentplatform.db -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($candidate) { $databasePath = $candidate.FullName; break }
    } while ((Get-Date) -lt $deadline)
    if (-not $databasePath) { throw "Packaged app did not create an isolated database during launch $round." }
    Start-Sleep -Seconds 2
    $process.Refresh()
    if ($process.HasExited) { throw "Packaged app did not remain running during launch $round." }
    $rendererMode = if ($round -eq 2) { 'activity' } else { 'startup' }
    $renderer = & node (Join-Path $PSScriptRoot 'smoke-renderer.cjs') $port $rendererMode
    if ($LASTEXITCODE -ne 0) { throw "Renderer did not load during launch $round." }
    $rendererChecks += ($renderer | ConvertFrom-Json)
    Stop-SmokeProcess $process.Id
    if ($round -eq 1) {
      & node (Join-Path $PSScriptRoot 'smoke-db-fixture.cjs') insert $databasePath
      if ($LASTEXITCODE -ne 0) { throw 'Could not insert restart fixture into isolated database.' }
    }
  }
  & node (Join-Path $PSScriptRoot 'smoke-db-fixture.cjs') verify $databasePath
  if ($LASTEXITCODE -ne 0) { throw 'Restart did not preserve the isolated fixture.' }
  $report = [ordered]@{ status = 'PASS'; model_calls = 0; launches = 2; isolated_database = $databasePath; fixture_preserved = $true; renderer_checks = $rendererChecks; package_sha256 = (Get-FileHash -LiteralPath (Join-Path $workspace 'release\AgentPlatform-win32-x64.zip') -Algorithm SHA256).Hash.ToLowerInvariant(); process_ids = $started }
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'result.json') -Encoding utf8
  Write-Output ($report | ConvertTo-Json -Compress)
} finally {
  foreach ($processId in $started) { Stop-SmokeProcess $processId }
  $env:APPDATA = $oldAppData
  $env:LOCALAPPDATA = $oldLocalAppData
  $env:AGENTPLATFORM_USER_DATA_DIR = $oldUserDataOverride
}
