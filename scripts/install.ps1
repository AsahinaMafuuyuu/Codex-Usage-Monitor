[CmdletBinding()]
param(
  [string]$MigrateFrom
)

$ErrorActionPreference = 'Stop'
$ReleaseManifestUri = 'https://github.com/AsahinaMafuuyuu/Codex-Usage-Monitor/releases/latest/download/release-manifest.json'
$AllowedReleaseHosts = @('github.com', 'release-assets.githubusercontent.com')

function Assert-Node24 {
  $versionText = & node --version 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $versionText) {
    throw 'Node.js 24 or newer is required.'
  }
  $match = [regex]::Match($versionText.Trim(), '^v(\d+)\.(\d+)\.(\d+)')
  if (-not $match.Success -or [int]$match.Groups[1].Value -lt 24) {
    throw "Node.js 24 or newer is required; found $versionText"
  }
}

function New-HttpClient {
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(30)
  return $client
}

function Invoke-TrustedReleaseDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  $client = New-HttpClient
  try {
    $current = [Uri]$Uri
    for ($redirects = 0; $redirects -le 5; $redirects++) {
      if ($current.Scheme -ne 'https') { throw "Release URL must stay on HTTPS: $current" }
      if ($current.UserInfo) { throw "Release URL credentials are forbidden: $current" }
      if ($AllowedReleaseHosts -notcontains $current.DnsSafeHost.ToLowerInvariant()) {
        throw "Release redirect host is not trusted: $($current.DnsSafeHost)"
      }
      $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $current)
      $request.Headers.UserAgent.ParseAdd('codex-usage-monitor-installer/1')
      $response = $client.SendAsync($request).GetAwaiter().GetResult()
      try {
        $status = [int]$response.StatusCode
        if ($status -ge 300 -and $status -lt 400) {
          if ($redirects -eq 5) { throw 'Release redirect limit exceeded.' }
          $location = $response.Headers.Location
          if (-not $location) { throw 'Release redirect did not include Location.' }
          if (-not $location.IsAbsoluteUri) { $location = [Uri]::new($current, $location) }
          $current = $location
          continue
        }
        if (-not $response.IsSuccessStatusCode) {
          throw "Release download failed with HTTP $status"
        }
        $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        [System.IO.File]::WriteAllBytes($Destination, $bytes)
        return
      } finally {
        $response.Dispose()
        $request.Dispose()
      }
    }
  } finally {
    $client.Dispose()
  }
}

function Assert-ManifestBootstrapFields {
  param([Parameter(Mandatory = $true)]$Manifest)
  if ($Manifest.schemaVersion -ne 1) { throw 'Unsupported release manifest schema.' }
  if ($Manifest.name -ne 'codex-usage-monitor') { throw 'Unexpected release package name.' }
  if ($Manifest.channel -ne 'stable') { throw 'Installer accepts stable releases only.' }
  if ($Manifest.runtime.platform -ne 'win32') { throw 'Installer accepts win32 releases only.' }
  if ($Manifest.tag -ne "v$($Manifest.version)") { throw 'Release tag/version mismatch.' }
  if ($Manifest.artifact.name -notmatch '^codex-usage-monitor-v\d+\.\d+\.\d+-win\.zip$') {
    throw 'Unexpected release artifact name.'
  }
  if ($Manifest.artifact.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'Release SHA-256 is invalid.' }
  if ([int64]$Manifest.artifact.size -le 0) { throw 'Release artifact size is invalid.' }
}

function Assert-SafeZipEntries {
  param([Parameter(Mandatory = $true)][string]$ArchivePath)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      if ($name.StartsWith('/') -or $name -match '^[A-Za-z]:' -or $name.Split('/') -contains '..') {
        throw "Unsafe archive entry: $name"
      }
    }
  } finally {
    $archive.Dispose()
  }
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha256.ComputeHash($stream)
  } finally {
    $stream.Dispose()
    $sha256.Dispose()
  }
  return [System.BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant()
}

function Write-AtomicText {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Text
  )
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = "$Path.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
  [System.IO.File]::WriteAllText($temporary, $Text, [System.Text.UTF8Encoding]::new($false))
  Move-Item -Force -Path $temporary -Destination $Path
}

function New-ManagedShim {
  param([Parameter(Mandatory = $true)][string]$BinRoot)
  New-Item -ItemType Directory -Force -Path $BinRoot | Out-Null
  $shim = @'
@echo off
setlocal
set "ROOT=%LOCALAPPDATA%\CodexUsageMonitor"
if not exist "%ROOT%\state\current" (
  echo Codex Usage Monitor installation is incomplete: missing state\current. 1>&2
  exit /b 5
)
set /p VERSION=<"%ROOT%\state\current"
if "%VERSION%"=="" (
  echo Codex Usage Monitor installation is incomplete: empty current version. 1>&2
  exit /b 5
)
set "ENTRY=%ROOT%\app\v%VERSION%\bin\codex-usage-monitor.js"
if not exist "%ENTRY%" (
  echo Codex Usage Monitor installation is incomplete: missing %ENTRY%. 1>&2
  exit /b 5
)
set "CODEX_MONITOR_INSTALL_ROOT=%ROOT%"
node "%ENTRY%" %*
exit /b %ERRORLEVEL%
'@
  [System.IO.File]::WriteAllText((Join-Path $BinRoot 'codex-usage-monitor.cmd'), $shim, [System.Text.UTF8Encoding]::new($false))
}

function Add-UserPathEntry {
  param([Parameter(Mandatory = $true)][string]$PathEntry)
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($current -split ';' | Where-Object { $_ })
  if ($parts | Where-Object { $_.TrimEnd('\') -ieq $PathEntry.TrimEnd('\') }) { return $false }
  $next = if ($current) { "$current;$PathEntry" } else { $PathEntry }
  [Environment]::SetEnvironmentVariable('Path', $next, 'User')
  return $true
}

function Invoke-ManagedDatabaseMigration {
  param(
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [Parameter(Mandatory = $true)][string]$SourceDatabase,
    [Parameter(Mandatory = $true)][string]$DestinationDatabase
  )
  $previousSource = $env:CODEX_MONITOR_MIGRATE_SOURCE
  $previousDestination = $env:CODEX_MONITOR_MIGRATE_DEST
  try {
    $env:CODEX_MONITOR_MIGRATE_SOURCE = $SourceDatabase
    $env:CODEX_MONITOR_MIGRATE_DEST = $DestinationDatabase
    $script = "import { migrateManagedDatabase } from './src/install-operations.js'; const r=await migrateManagedDatabase({sourcePath:process.env.CODEX_MONITOR_MIGRATE_SOURCE,destinationPath:process.env.CODEX_MONITOR_MIGRATE_DEST}); console.log(JSON.stringify(r));"
    $output = & node --disable-warning=ExperimentalWarning --input-type=module -e $script 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Managed database migration failed: $output" }
    return ($output | Select-Object -Last 1 | ConvertFrom-Json)
  } finally {
    $env:CODEX_MONITOR_MIGRATE_SOURCE = $previousSource
    $env:CODEX_MONITOR_MIGRATE_DEST = $previousDestination
  }
}

function Install-CodexUsageMonitorFromArtifact {
  param(
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][string]$ArtifactPath,
    [Parameter(Mandatory = $true)][string]$LocalAppData,
    [string]$MigrateFrom,
    [bool]$UpdateUserPath = $true
  )
  Assert-Node24
  $manifest = Get-Content -Raw -Path $ManifestPath | ConvertFrom-Json
  Assert-ManifestBootstrapFields $manifest
  $artifactInfo = Get-Item $ArtifactPath
  if ($artifactInfo.Length -ne [int64]$manifest.artifact.size) { throw 'Release artifact size mismatch.' }
  $digest = Get-Sha256Hex -Path $ArtifactPath
  if ($digest -ne $manifest.artifact.sha256.ToLowerInvariant()) { throw 'Release artifact SHA-256 mismatch.' }
  Assert-SafeZipEntries $ArtifactPath

  $installRoot = Join-Path $LocalAppData 'CodexUsageMonitor'
  $appRoot = Join-Path $installRoot 'app'
  $stateRoot = Join-Path $installRoot 'state'
  $dataRoot = Join-Path $installRoot 'data'
  $binRoot = Join-Path $installRoot 'bin'
  $downloadsRoot = Join-Path $installRoot 'downloads'
  $backupsRoot = Join-Path $installRoot 'backups'
  foreach ($path in @($appRoot, $stateRoot, $dataRoot, $binRoot, $downloadsRoot, $backupsRoot)) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
  }
  $currentPath = Join-Path $stateRoot 'current'
  $markerPath = Join-Path $stateRoot 'install.json'
  $shimPath = Join-Path $binRoot 'codex-usage-monitor.cmd'
  if (Test-Path $currentPath) {
    throw 'Managed Install already has a current version; use codex-usage-monitor --update.'
  }

  $version = [string]$manifest.version
  $target = Join-Path $appRoot "v$version"
  $staging = Join-Path $appRoot "v$version.staging-$PID-$([Guid]::NewGuid().ToString('N'))"
  if (Test-Path $target) { throw "Managed version already exists: $target" }
  $migrationCreated = $false
  $targetMoved = $false
  $success = $false
  $destinationDatabase = Join-Path $dataRoot 'usage.sqlite'
  try {
    Expand-Archive -LiteralPath $ArtifactPath -DestinationPath $staging -Force
    $selfCheck = & node --disable-warning=ExperimentalWarning (Join-Path $staging 'bin\codex-usage-monitor.js') doctor --release-self-check 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Release self-check failed: $selfCheck" }

    $migration = $null
    if ($MigrateFrom) {
      $sourceDatabase = Join-Path ([System.IO.Path]::GetFullPath($MigrateFrom)) 'data\usage.sqlite'
      if (Test-Path $destinationDatabase) { throw 'Managed destination DB already exists; migration refused.' }
      Push-Location $staging
      try {
        $migration = Invoke-ManagedDatabaseMigration -ReleaseRoot $staging -SourceDatabase $sourceDatabase -DestinationDatabase $destinationDatabase
        $migrationCreated = $true
      } finally {
        Pop-Location
      }
    }

    $marker = [ordered]@{
      schemaVersion = 1
      name = 'codex-usage-monitor'
      installedAt = [DateTime]::UtcNow.ToString('o')
      migration = if ($migration) {
        [ordered]@{
          sourcePath = [System.IO.Path]::GetFullPath($MigrateFrom)
          migratedAt = [DateTime]::UtcNow.ToString('o')
          sourceSchema = [int]$migration.sourceSchema
          destinationSchema = [int]$migration.destinationSchema
        }
      } else { $null }
    }
    Write-AtomicText -Path $markerPath -Text (($marker | ConvertTo-Json -Depth 5) + "`n")
    New-ManagedShim -BinRoot $binRoot
    Move-Item -Path $staging -Destination $target
    $targetMoved = $true
    $staging = $null
    Write-AtomicText -Path $currentPath -Text "$version`n"

    $previousLocalAppData = $env:LOCALAPPDATA
    try {
      $env:LOCALAPPDATA = $LocalAppData
      $versionOutput = & (Join-Path $binRoot 'codex-usage-monitor.cmd') --version 2>&1
      if ($LASTEXITCODE -ne 0) { throw "Installed --version failed: $versionOutput" }
    } finally {
      $env:LOCALAPPDATA = $previousLocalAppData
    }
    $pathChanged = if ($UpdateUserPath) { Add-UserPathEntry $binRoot } else { $false }
    $success = $true
    return [pscustomobject]@{
      InstallRoot = $installRoot
      Version = $version
      PathChanged = $pathChanged
      Migration = $migration
    }
  } catch {
    Remove-Item -Force $currentPath -ErrorAction SilentlyContinue
    Remove-Item -Force $markerPath -ErrorAction SilentlyContinue
    Remove-Item -Force $shimPath -ErrorAction SilentlyContinue
    if ($targetMoved -and (Test-Path $target)) { Remove-Item -Recurse -Force $target }
    if ($migrationCreated -and (Test-Path $destinationDatabase)) { Remove-Item -Force $destinationDatabase }
    throw
  } finally {
    if ($staging -and (Test-Path $staging)) { Remove-Item -Recurse -Force $staging }
  }
}

function Invoke-CodexUsageMonitorInstall {
  param([string]$MigrateFrom)
  if ($env:OS -ne 'Windows_NT') { throw 'Managed Install v1.2.0 supports Windows only.' }
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required.' }
  Assert-Node24
  $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "codex-usage-monitor-install-$PID-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
  try {
    $manifestPath = Join-Path $temporaryRoot 'release-manifest.json'
    Invoke-TrustedReleaseDownload -Uri $ReleaseManifestUri -Destination $manifestPath
    $manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
    Assert-ManifestBootstrapFields $manifest
    $artifactPath = Join-Path $temporaryRoot ([string]$manifest.artifact.name)
    $artifactUri = "https://github.com/AsahinaMafuuyuu/Codex-Usage-Monitor/releases/download/$($manifest.tag)/$($manifest.artifact.name)"
    Invoke-TrustedReleaseDownload -Uri $artifactUri -Destination $artifactPath
    $result = Install-CodexUsageMonitorFromArtifact -ManifestPath $manifestPath -ArtifactPath $artifactPath -LocalAppData $env:LOCALAPPDATA -MigrateFrom $MigrateFrom -UpdateUserPath $true
    Write-Host "Codex Usage Monitor $($result.Version) installed at $($result.InstallRoot)"
    if ($result.PathChanged) { Write-Host 'Open a new terminal before using codex-usage-monitor from PATH.' }
  } finally {
    Remove-Item -Recurse -Force $temporaryRoot -ErrorAction SilentlyContinue
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-CodexUsageMonitorInstall -MigrateFrom $MigrateFrom
}
