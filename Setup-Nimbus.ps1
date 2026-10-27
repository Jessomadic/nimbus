$ErrorActionPreference='Stop'
Push-Location $PSScriptRoot
try{
  & (Join-Path $PSScriptRoot 'Secure-Nimbus.ps1')
  & node.exe -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))process.exit(1)'
  if($LASTEXITCODE -ne 0){throw 'Nimbus requires Node.js 22.13 or newer.'}
  & npm.cmd ci
  if($LASTEXITCODE -ne 0){throw 'Dependency installation failed.'}
  & npm.cmd run browser:install
  if($LASTEXITCODE -ne 0){throw 'Browser installation failed.'}
  & node.exe --no-warnings bin/setup.mjs
  if($LASTEXITCODE -ne 0){throw 'Nimbus configuration failed.'}
  & npm.cmd run doctor
}finally{Pop-Location}
