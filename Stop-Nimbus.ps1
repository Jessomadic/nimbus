$ErrorActionPreference='Stop'
$nimbusRoot=$PSScriptRoot
Set-Content -LiteralPath (Join-Path $nimbusRoot 'data\stop.request') -Value 'stop'
Push-Location $nimbusRoot
try{& node.exe --no-warnings --env-file-if-exists=.env (Join-Path $nimbusRoot 'bin\nimbus.mjs') POST /api/admin/shutdown '{}'}finally{Pop-Location}
