param([string]$PgBin = 'C:/Program Files/PostgreSQL/17/bin', [string]$PsqlBin = '')
$ErrorActionPreference = 'Stop'
if (-not $PsqlBin) { $PsqlBin = $PgBin }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runDir = Join-Path $repo ('artifacts/ratings/native-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $runDir 'data'
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
if ($port -lt 49152 -or $port -gt 65535) { throw 'OS did not allocate a disposable dynamic port' }
New-Item -ItemType Directory -Force $runDir | Out-Null
$started = $false
try {
  & "$pgBin/initdb.exe" -D $dataDir -U ratings_fixture_admin --auth=trust --encoding=UTF8 --locale=C > (Join-Path $runDir 'initdb.log') 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'Disposable initdb failed' }
  $startArgs = '-D "' + $dataDir + '" -l "' + (Join-Path $runDir 'postgres.log') + '" -o "-h 127.0.0.1 -p ' + $port + ' -c listen_addresses=127.0.0.1" -w start'
  # pg_ctl's descendant inherits Windows process handles. Do not wait on those
  # handles; poll this cluster's PostgreSQL readiness marker instead.
  $null = Start-Process -FilePath "$pgBin/pg_ctl.exe" -ArgumentList $startArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runDir 'start.log') -RedirectStandardError (Join-Path $runDir 'start.err')
  for ($attempt = 0; $attempt -lt 150; $attempt++) {
    $pidFile = Join-Path $dataDir 'postmaster.pid'
    if ((Test-Path -LiteralPath $pidFile) -and (((Get-Content -LiteralPath $pidFile) | ForEach-Object { $_.Trim() }) -contains 'ready')) { $started = $true; break }
    Start-Sleep -Milliseconds 200
  }
  if (-not $started) { throw 'Disposable server startup failed; inspect start/postgres logs' }
  $started = $true
  Push-Location $repo
  try {
    & node tests/ratings/run.mjs "--native-port=$port" "--pg-bin=$PsqlBin" 2>&1 | Tee-Object -FilePath (Join-Path $runDir 'results.txt')
    $result = $LASTEXITCODE
  } finally { Pop-Location }
  if ($result -ne 0) { throw 'Native PostgreSQL 17 Ratings checks failed' }
} finally {
  if (Test-Path -LiteralPath (Join-Path $dataDir 'postmaster.pid')) {
    & "$pgBin/pg_ctl.exe" -D $dataDir -m fast -w stop > (Join-Path $runDir 'stop.log') 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Disposable server did not stop; preserving data directory' }
  }
  $resolvedData = [IO.Path]::GetFullPath($dataDir)
  $resolvedRun = [IO.Path]::GetFullPath($runDir)
  if ($resolvedData -eq (Join-Path $resolvedRun 'data') -and $resolvedRun.StartsWith((Join-Path $repo 'artifacts/ratings') + [IO.Path]::DirectorySeparatorChar) -and (Test-Path -LiteralPath $resolvedData)) {
    Remove-Item -LiteralPath $resolvedData -Recurse -Force
  }
  Write-Output "Disposable run artifacts: $runDir"
}
