param([string]$PgBin = 'C:/Program Files/PostgreSQL/17/bin')
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runDir = Join-Path $repo ('artifacts/ratings/native-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $runDir 'data'
$port = Get-Random -Minimum 49152 -Maximum 65535
New-Item -ItemType Directory -Force $runDir | Out-Null
$started = $false
try {
  & "$pgBin/initdb.exe" -D $dataDir -U ratings_fixture_admin --auth=trust --encoding=UTF8 --locale=C > (Join-Path $runDir 'initdb.log') 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'Disposable initdb failed' }
  $startArgs = '-D "' + $dataDir + '" -l "' + (Join-Path $runDir 'postgres.log') + '" -o "-h 127.0.0.1 -p ' + $port + ' -c listen_addresses=127.0.0.1" -w start'
  $starter = Start-Process -FilePath "$pgBin/pg_ctl.exe" -ArgumentList $startArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runDir 'start.log') -RedirectStandardError (Join-Path $runDir 'start.err')
  if (-not $starter.WaitForExit(30000) -or $starter.ExitCode -ne 0) { throw 'Disposable server startup failed' }
  $started = $true
  Push-Location $repo
  try {
    & node tests/ratings/run.mjs "--native-port=$port" "--pg-bin=$PgBin" 2>&1 | Tee-Object -FilePath (Join-Path $runDir 'results.txt')
    $result = $LASTEXITCODE
  } finally { Pop-Location }
  if ($result -ne 0) { throw 'Native PostgreSQL 17 Ratings checks failed' }
} finally {
  if ($started) { & "$pgBin/pg_ctl.exe" -D $dataDir -m fast -w stop > (Join-Path $runDir 'stop.log') 2>&1 }
  $resolvedData = [IO.Path]::GetFullPath($dataDir)
  $resolvedRun = [IO.Path]::GetFullPath($runDir)
  if ($resolvedData -eq (Join-Path $resolvedRun 'data') -and $resolvedRun.StartsWith((Join-Path $repo 'artifacts/ratings') + [IO.Path]::DirectorySeparatorChar) -and (Test-Path -LiteralPath $resolvedData)) {
    Remove-Item -LiteralPath $resolvedData -Recurse -Force
  }
  Write-Output "Disposable run artifacts: $runDir"
}
