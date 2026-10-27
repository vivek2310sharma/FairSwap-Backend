param(
 [Parameter(Mandatory=$true)][string]$PgBin,
 [string]$PsqlBin = 'C:/Program Files/PostgreSQL/17/bin'
)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if (-not [IO.Path]::IsPathFullyQualified($PgBin)) { throw 'Absolute PG17 bin required' }
$version=& "$PgBin/postgres.exe" --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^postgres \(PostgreSQL\) 17\.') { throw 'PG17 required' }
foreach ($environment in @('test','production')) {
 $runDir=Join-Path $repo ('artifacts/ratings/hosted-' + [guid]::NewGuid().ToString('N'))
 $dataDir=Join-Path $runDir 'data'
 New-Item -ItemType Directory -Path $runDir | Out-Null
 $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
 $listener.Start(); $port=$listener.LocalEndpoint.Port; $listener.Stop()
 if ($port -lt 49152 -or $port -gt 65535) { throw 'Disposable dynamic port required' }
 try {
  & "$PgBin/initdb.exe" -D $dataDir -U ratings_fixture_admin --auth=trust --encoding=UTF8 --locale=C > (Join-Path $runDir 'initdb.txt') 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
  $startArgs='-D "'+$dataDir+'" -l "'+(Join-Path $runDir 'postgres.log')+'" -o "-h 127.0.0.1 -p '+$port+' -c listen_addresses=127.0.0.1" -w start'
  $null=Start-Process -FilePath "$PgBin/pg_ctl.exe" -ArgumentList $startArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runDir 'start.txt') -RedirectStandardError (Join-Path $runDir 'start.err')
  $started=$false
  for ($attempt=0;$attempt -lt 150;$attempt++) {
   $pidFile=Join-Path $dataDir 'postmaster.pid'
   if ((Test-Path -LiteralPath $pidFile) -and ((Get-Content -LiteralPath $pidFile).Trim() -contains 'ready')) { $started=$true; break }
   Start-Sleep -Milliseconds 200
  }
  if (-not $started) { throw 'Disposable server startup failed' }
  Push-Location $repo
  try {
   $suiteArgs=@("--environment=$environment","--native-port=$port","--pg-bin=$PsqlBin")
   & node (Join-Path $PSScriptRoot 'regression.mjs') @suiteArgs 2>&1 | Tee-Object -FilePath (Join-Path $runDir 'results.txt')
   if ($LASTEXITCODE -ne 0) { throw "PG17 $environment regression failed" }
  } finally { Pop-Location }
 } finally {
  if (Test-Path -LiteralPath (Join-Path $dataDir 'postmaster.pid')) {
   & "$PgBin/pg_ctl.exe" -D $dataDir -m fast -w stop > (Join-Path $runDir 'stop.txt') 2>&1
   if ($LASTEXITCODE -ne 0) { throw 'Stop failed; preserving cluster' }
  }
  $resolvedRun=[IO.Path]::GetFullPath($runDir)
  $resolvedData=[IO.Path]::GetFullPath($dataDir)
  if ($resolvedRun.StartsWith((Join-Path $repo 'artifacts/ratings/hosted-')) -and $resolvedData -eq (Join-Path $resolvedRun 'data') -and (Test-Path -LiteralPath $resolvedData)) { Remove-Item -LiteralPath $resolvedData -Recurse -Force }
  Write-Output "Disposable run artifacts: $runDir"
 }
}
