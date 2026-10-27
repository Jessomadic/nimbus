param(
  [string]$ModelKey='google/gemma-4-e4b', [string]$Identifier='nimbus-local', [string]$LmsBin='lms.exe',
  [int]$ContextLength=131072, [double]$GpuRatio=0.2,
  [int]$ForecastGpuMB=6500, [int]$ForecastRamMB=15625,
  [ValidateRange(10,90)][int]$ResourceCeiling=90
)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'LocalModelHelpers.psm1') -Force
$lmsPath=(Get-Command $LmsBin -ErrorAction Stop).Source
function Get-NimbusResourceUse {
  $output=& nvidia-smi.exe --query-gpu=memory.total,memory.used --format=csv,noheader,nounits
  if($LASTEXITCODE -ne 0 -or -not $output){throw 'GPU memory could not be inspected.'}
  $gpu=(@($output)[0] -split ',');$os=Get-CimInstance Win32_OperatingSystem
  [pscustomobject]@{GpuTotal=[double]$gpu[0];GpuUsed=[double]$gpu[1];RamTotal=[double]$os.TotalVisibleMemorySize/1024;RamUsed=([double]$os.TotalVisibleMemorySize-[double]$os.FreePhysicalMemory)/1024}
}
$rawModels=& $lmsPath ps --json
if($LASTEXITCODE -ne 0){throw 'Loaded models could not be inspected.'}
$loaded=@(ConvertFrom-NimbusModelJson -Json ($rawModels|Out-String))
$present=@($loaded|Where-Object {$_.identifier -eq $Identifier})
if($present.Count){
  if($present[0].contextLength -ne $ContextLength){throw 'The managed model has a different context size; Nimbus will not replace an existing load.'}
  exit 0
}
if($loaded.Count -gt 0){throw 'Another model is already loaded. Nimbus will reuse an approved loaded model or defer; it will not create another resident agent model.'}
$use=Get-NimbusResourceUse;$fraction=$ResourceCeiling/100.0
if($use.GpuUsed+$ForecastGpuMB -gt $use.GpuTotal*$fraction -or $use.RamUsed+$ForecastRamMB -gt $use.RamTotal*$fraction){throw 'The projected load would exceed the configured RAM or VRAM ceiling.'}
& $lmsPath load $ModelKey --identifier $Identifier --gpu $GpuRatio -c $ContextLength --parallel 1 --ttl 300 -y | Out-Null
if($LASTEXITCODE -ne 0){throw 'The managed local model could not load.'}
$rawReady=& $lmsPath ps --json
$ready=@(ConvertFrom-NimbusModelJson -Json ($rawReady|Out-String)|Where-Object {$_.identifier -eq $Identifier})
if($ready.Count -ne 1 -or $ready[0].contextLength -ne $ContextLength -or $ready[0].ttlMs -gt 300000 -or $ready[0].ttlMs -le 0){throw 'LM Studio did not confirm the requested context and idle timeout.'}
$after=Get-NimbusResourceUse
if($after.GpuUsed -gt $after.GpuTotal*$fraction -or $after.RamUsed -gt $after.RamTotal*$fraction){
  if($ready[0].status -eq 'idle' -and $ready[0].queued -eq 0){& $lmsPath unload $Identifier|Out-Null}
  throw 'The loaded model exceeded the resource ceiling.'
}
