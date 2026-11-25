$ErrorActionPreference='Stop'
$nimbusRoot=$PSScriptRoot
$nimbusIdentity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
# Compile off to the side; never overwrite a registered executable.
function Get-NimbusSha256([string]$Path) {
    $sha=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path)))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Assert-NimbusGui([string]$Path) {
    $bytes=[IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or [BitConverter]::ToUInt16($bytes,0) -ne 0x5a4d) { throw 'Invalid launcher DOS header' }
    $pe=[BitConverter]::ToInt32($bytes,60)
    if ($pe -lt 0 -or ($pe+94) -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes,$pe) -ne 0x4550 -or [BitConverter]::ToUInt16($bytes,$pe+92) -ne 2) { throw 'Launcher must be Windows GUI subsystem' }
}
$source=Join-Path $nimbusRoot 'scripts\startup\HiddenStart.cs'
# Resolve desktop Framework independently of the hosting PowerShell runtime.
$compiler=$null
$frameworks=@('Framework','Framework64')
if ([Environment]::Is64BitOperatingSystem) { $frameworks=@('Framework64','Framework') }
foreach ($framework in $frameworks) {
    $path=Join-Path $env:SystemRoot ("Microsoft.NET\"+$framework+"\v4.0.30319\csc.exe")
    if (Test-Path -LiteralPath $path -PathType Leaf) { $compiler=$path; break }
}
if (!$compiler) { throw 'No installed Windows .NET Framework v4 C# compiler' }
function Assert-NimbusStage([string]$Root,[string]$Stage,[string]$Id) {
    $r=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    $s=[IO.Path]::GetFullPath($Stage).TrimEnd('\')
    if ($Id -notmatch '^[0-9a-f]{32}$' -or
        ![string]::Equals([IO.Path]::GetDirectoryName($s),$r,[StringComparison]::OrdinalIgnoreCase) -or
        ![string]::Equals([IO.Path]::GetFileName($s),$Id,[StringComparison]::Ordinal)) { throw 'Unsafe staging cleanup path' }
    foreach ($p in @($r,$s)) {
        if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Staging reparse point rejected' }
    }
}
if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing launcher source: $source" }
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) { throw "No installed framework C# compiler: $compiler" }
$buildRoot=Join-Path $nimbusRoot 'data\host-tools\nimbus-hidden-start\builds'
[IO.Directory]::CreateDirectory($buildRoot) | Out-Null
$cache=Join-Path $buildRoot ((Get-NimbusSha256 $source)+'-'+(Get-NimbusSha256 $compiler)+'.json')
$launcher=$null
if (Test-Path -LiteralPath $cache) {
    $record=Get-Content -Raw -LiteralPath $cache | ConvertFrom-Json
    if ($record.hash -notmatch '^[0-9a-f]{64}$') { throw 'Invalid launcher cache' }
    $launcher=Join-Path $buildRoot ('NimbusHiddenStart-'+$record.hash+'.exe')
    if ((Get-NimbusSha256 $launcher) -ne $record.hash) { throw 'Cached launcher hash mismatch' }
    Assert-NimbusGui $launcher
}
if (!$launcher) {
$stageId=[Guid]::NewGuid().ToString('N')
$temp=Join-Path $buildRoot $stageId
Assert-NimbusStage $buildRoot $temp $stageId
if (Test-Path -LiteralPath $temp) { throw 'Stage exists' }
[IO.Directory]::CreateDirectory($temp) | Out-Null
$createdStage=$temp
try {
    $candidate=Join-Path $temp 'NimbusHiddenStart.exe'
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$compiler
    $info.Arguments='/nologo /target:winexe /optimize+ /out:"'+$candidate+'" "'+$source+'"'
    $info.UseShellExecute=$false
    $info.CreateNoWindow=$true
    $info.WindowStyle='Hidden'
    $info.RedirectStandardOutput=$true
    $info.RedirectStandardError=$true
    $process=New-Object Diagnostics.Process
    $process.StartInfo=$info
    try {
        if (!$process.Start()) { throw 'Compiler did not start' }
        $stdout=$process.StandardOutput.ReadToEndAsync()
        $stderr=$process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw ('Launcher compilation failed: '+$stdout.Result+$stderr.Result) }
    } finally { $process.Dispose() }
    Assert-NimbusGui $candidate
    $hash=Get-NimbusSha256 $candidate
    $launcher=Join-Path $buildRoot ('NimbusHiddenStart-'+$hash+'.exe')
    if (Test-Path -LiteralPath $launcher) {
        if ((Get-NimbusSha256 $launcher) -ne $hash) { throw 'Existing launcher hash mismatch' }
        Assert-NimbusGui $launcher
    } else { [IO.File]::Move($candidate,$launcher) }
    @{hash=$hash} | ConvertTo-Json | Set-Content -LiteralPath $cache -Encoding UTF8
} finally {
    # Only this invocation's exact staging directory is removed.
    if ($temp -ne $createdStage) { throw 'Stage ownership mismatch' }
    Assert-NimbusStage $buildRoot $temp $stageId
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
}
$nimbusAction=New-ScheduledTaskAction -Execute $launcher -Argument ('"'+(Join-Path $nimbusRoot '.')+'"') -WorkingDirectory $nimbusRoot
$nimbusTrigger=New-ScheduledTaskTrigger -AtLogOn -User $nimbusIdentity
# A calendar recovery trigger covers a missed logon trigger and exhausted
# failure retries. IgnoreNew prevents it from duplicating a healthy supervisor.
$nimbusRecovery=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$nimbusRecovery.Repetition.StopAtDurationEnd=$false
$nimbusPrincipal=New-ScheduledTaskPrincipal -UserId $nimbusIdentity -LogonType Interactive -RunLevel Limited
$nimbusSettings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'Nimbus' -Action $nimbusAction -Trigger @($nimbusTrigger,$nimbusRecovery) -Principal $nimbusPrincipal -Settings $nimbusSettings -Description 'Nimbus sign-in startup and minute recovery. Runs its foreground supervisor independently of Codex with current-account protected credentials. Intentional stop requests are respected.' -Force | Out-Null
Write-Output 'Nimbus starts when you sign in, retries failures, and recovers a missed start every minute. Run Start-Nimbus.ps1 after an intentional stop to re-enable automatic startup.'
