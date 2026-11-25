# Registers a weekly full permission audit for this checkout. Ordinary starts run
# Secure-Nimbus.ps1 -Mode Incremental; this Full scan also catches an in-place
# ACL edit by an administrator. It shares the start scan's lock, so it never runs
# at the same time as a startup check.
param()
$ErrorActionPreference='Stop'
$nimbusRoot=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$nimbusIdentity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$nimbusScript=Join-Path $nimbusRoot 'Secure-Nimbus.ps1'
$nimbusAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$nimbusScript+'" -Mode Full') -WorkingDirectory $nimbusRoot
$nimbusTrigger=New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '3:30AM'
$nimbusPrincipal=New-ScheduledTaskPrincipal -UserId $nimbusIdentity -LogonType Interactive -RunLevel Limited
$nimbusSettings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Priority 7 -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'Nimbus permission audit' -Action $nimbusAction -Trigger $nimbusTrigger -Principal $nimbusPrincipal -Settings $nimbusSettings -Description 'Weekly full check that every file in the Nimbus checkout is private to its owner, SYSTEM and Administrators.' -Force | Out-Null
Write-Output 'Weekly full Nimbus permission audit registered for Sundays at 3:30 AM.'
