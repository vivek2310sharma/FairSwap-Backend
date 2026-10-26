$ErrorActionPreference='Stop'
$pgBin='C:/Program Files/PostgreSQL/17/bin'
if(-not (Test-Path -LiteralPath "$pgBin/psql.exe")){throw 'Local PG17 unavailable'}
$taskTemp=Join-Path ([IO.Path]::GetTempPath()) ('chat-inbox-native-'+[Guid]::NewGuid())
[IO.Directory]::CreateDirectory($taskTemp) | Out-Null
$dataPath=Join-Path $taskTemp 'data'
$port=Get-Random -Minimum 49152 -Maximum 65535
try {
  & "$pgBin/initdb.exe" -D $dataPath -U inbox_fixture_admin --auth-local=trust --auth-host=trust *> "$taskTemp/init.log"
  if($LASTEXITCODE -ne 0){throw 'Disposable cluster init failed'}
  & "$pgBin/pg_ctl.exe" -D $dataPath -l "$taskTemp/server.log" -o "-h 127.0.0.1 -p $port" -w start *> "$taskTemp/start.log"
  if($LASTEXITCODE -ne 0){throw 'Disposable cluster start failed'}
  $version=& "$pgBin/psql.exe" -XAt -h 127.0.0.1 -p $port -U inbox_fixture_admin -d postgres -c 'show server_version_num'
  if([int]$version -lt 170000 -or [int]$version -ge 180000){throw 'PG17 required'}
  node scripts/ci/emit-chat-inbox-native.mjs | Set-Content -Encoding utf8 "$taskTemp/fixture.sql"
  if($LASTEXITCODE -ne 0){throw 'Fixture emitter failed'}
  & "$pgBin/psql.exe" -XAtq -h 127.0.0.1 -p $port -U inbox_fixture_admin -d postgres -v ON_ERROR_STOP=1 -f "$taskTemp/fixture.sql" *> "$taskTemp/result.log"
  if($LASTEXITCODE -ne 0){Get-Content "$taskTemp/result.log" -Tail 12;throw 'Native fixture failed'}
  "PASS native PG $version inbox security and migration contract"
} finally {
  if(Test-Path -LiteralPath "$dataPath/postmaster.pid"){ & "$pgBin/pg_ctl.exe" -D $dataPath -m immediate -w stop *> $null }
  # Keep private synthetic diagnostics for automated failure analysis; never upload.
}
