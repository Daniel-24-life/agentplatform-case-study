$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$release = [System.IO.Path]::GetFullPath((Join-Path $repo "release"))
$stage = [System.IO.Path]::GetFullPath((Join-Path $release "AgentPlatform-win32-x64"))
$zip = [System.IO.Path]::GetFullPath((Join-Path $release "AgentPlatform-win32-x64.zip"))
$electron = Join-Path $repo "node_modules\electron\dist"
if (-not (Test-Path (Join-Path $repo "out\main\index.js"))) { throw "Run the build before packaging." }
if (-not (Test-Path (Join-Path $electron "electron.exe"))) { throw "Electron runtime is not installed." }
if ((Split-Path -Parent $stage) -ne $release -or (Split-Path -Parent $zip) -ne $release) { throw "Package paths must stay inside release." }

# Keep the previous application and archive reviewable instead of deleting them.
if ((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $zip)) {
    $backup = [System.IO.Path]::GetFullPath((Join-Path $release ("pre-package-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8))))
    if ((Split-Path -Parent $backup) -ne $release) { throw "Backup path must stay inside release." }
    New-Item -ItemType Directory -Path $backup | Out-Null
    if (Test-Path -LiteralPath $stage) { Move-Item -LiteralPath $stage -Destination (Join-Path $backup "AgentPlatform-win32-x64") }
    if (Test-Path -LiteralPath $zip) { Move-Item -LiteralPath $zip -Destination (Join-Path $backup "AgentPlatform-win32-x64.zip") }
    Write-Host "Previous package retained at $backup"
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item -Path (Join-Path $electron "*") -Destination $stage -Recurse -Force
Move-Item -LiteralPath (Join-Path $stage "electron.exe") -Destination (Join-Path $stage "AgentPlatform.exe")
New-Item -ItemType Directory -Path (Join-Path $stage "resources\app") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo "out") -Destination (Join-Path $stage "resources\app\out") -Recurse
Copy-Item -LiteralPath (Join-Path $repo "schemas") -Destination (Join-Path $stage "resources\app\schemas") -Recurse
Copy-Item -LiteralPath (Join-Path $repo "package.json") -Destination (Join-Path $stage "resources\app\package.json")
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
Write-Host "Created $zip"
