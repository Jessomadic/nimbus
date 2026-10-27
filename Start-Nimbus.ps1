param([switch]$Foreground)
$ErrorActionPreference='Stop'
$nimbusRoot=$PSScriptRoot
& (Join-Path $nimbusRoot 'Secure-Nimbus.ps1')
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
$nimbusData=Join-Path $nimbusRoot 'data'
New-Item -ItemType Directory -Path $nimbusData -Force | Out-Null
$stopMarker=Join-Path $nimbusData 'stop.request'
if(Test-Path -LiteralPath $stopMarker){Remove-Item -LiteralPath $stopMarker}
if($Foreground){Push-Location $nimbusRoot;try{& $nodePath --no-warnings --env-file-if-exists=.env (Join-Path $nimbusRoot 'scripts\supervisor.mjs')}finally{Pop-Location};exit $LASTEXITCODE}
$supervisor=Join-Path $nimbusRoot 'scripts\supervisor.mjs'
Start-Process -FilePath $nodePath -ArgumentList @('--no-warnings','--env-file-if-exists=.env',('"'+$supervisor+'"')) -WorkingDirectory $nimbusRoot -WindowStyle Hidden | Out-Null
Write-Output 'Nimbus is starting in the background. Open http://127.0.0.1:8787 after the health check succeeds.'
