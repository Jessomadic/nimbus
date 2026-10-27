$ErrorActionPreference='Stop'
$nimbusRoot=$PSScriptRoot
$nimbusIdentity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$nimbusAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -File "'+(Join-Path $nimbusRoot 'Start-Nimbus.ps1')+'"') -WorkingDirectory $nimbusRoot
$nimbusTrigger=New-ScheduledTaskTrigger -AtLogOn -User $nimbusIdentity
$nimbusPrincipal=New-ScheduledTaskPrincipal -UserId $nimbusIdentity -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Nimbus' -Action $nimbusAction -Trigger $nimbusTrigger -Principal $nimbusPrincipal -Description 'Nimbus Windows worker team. Uses the current account model login and protected credentials.' -Force | Out-Null
Write-Output 'Nimbus will start when this Windows user signs in.'
