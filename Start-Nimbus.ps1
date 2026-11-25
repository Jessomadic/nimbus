param([switch]$Foreground,[switch]$Automatic)
$ErrorActionPreference='Stop'
$nimbusRoot=$PSScriptRoot
$nimbusData=Join-Path $nimbusRoot 'data'
$stopMarker=Join-Path $nimbusData 'stop.request'
# Automatic recovery must not undo an intentional Stop-Nimbus.ps1 request.
if($Automatic -and (Test-Path -LiteralPath $stopMarker)){Write-Output 'Nimbus automatic start is suspended by its stop request. Run Start-Nimbus.ps1 to resume.';exit 0}
if($Automatic){
  # A healthy instance can outlive its scheduler wrapper. A recovery tick must
  # leave that instance alone and avoid rescanning the entire checkout's ACLs.
  $nimbusLock=Join-Path $nimbusData 'supervisor.lock'
  if(Test-Path -LiteralPath $nimbusLock){
    try{
      $nimbusLockData=Get-Content -LiteralPath $nimbusLock -Raw | ConvertFrom-Json
      $nimbusExisting=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$nimbusLockData.pid) -ErrorAction Stop
      $nimbusSupervisorPath=Join-Path $nimbusRoot 'scripts\supervisor.mjs'
      if([IO.Path]::GetFullPath($nimbusLockData.root) -eq [IO.Path]::GetFullPath($nimbusRoot) -and
         $nimbusExisting.Name -eq 'node.exe' -and $nimbusExisting.CommandLine -and
         $nimbusExisting.CommandLine.IndexOf($nimbusSupervisorPath,[StringComparison]::OrdinalIgnoreCase) -ge 0){
        Write-Output 'Nimbus is already supervised; automatic recovery left it running.';exit 0
      }
    }catch{Write-Verbose ('Checking the previous supervisor: '+$_.Exception.Message)}
  }
}
& (Join-Path $nimbusRoot 'Secure-Nimbus.ps1')
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $nimbusData -Force | Out-Null
if(Test-Path -LiteralPath $stopMarker){Remove-Item -LiteralPath $stopMarker}
if($Foreground){Push-Location $nimbusRoot;try{& $nodePath --no-warnings --env-file-if-exists=.env (Join-Path $nimbusRoot 'scripts\supervisor.mjs')}finally{Pop-Location};exit $LASTEXITCODE}
$supervisor=Join-Path $nimbusRoot 'scripts\supervisor.mjs'
Start-Process -FilePath $nodePath -ArgumentList @('--no-warnings','--env-file-if-exists=.env',('"'+$supervisor+'"')) -WorkingDirectory $nimbusRoot -WindowStyle Hidden | Out-Null
Write-Output 'Nimbus is starting in the background. Open http://127.0.0.1:8787 after the health check succeeds.'
