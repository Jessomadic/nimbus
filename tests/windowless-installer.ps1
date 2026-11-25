
param([string]$OutputRoot)
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path $PSScriptRoot
if (!$OutputRoot) { $OutputRoot=Join-Path ([IO.Path]::GetTempPath()) ('nimbus-windowless-'+[Guid]::NewGuid().ToString('N')) }
$base=[IO.Path]::GetFullPath($OutputRoot)
[IO.Directory]::CreateDirectory($base)|Out-Null
$results=New-Object Collections.Generic.List[object]
function Check($name,$ok,$detail) { $results.Add([pscustomobject]@{name=$name;pass=[bool]$ok;detail=$detail}); if (!$ok) { throw "FAIL: $name" } }
function Hash($path) { $s=[Security.Cryptography.SHA256]::Create();try { ([BitConverter]::ToString($s.ComputeHash([IO.File]::ReadAllBytes($path)))).Replace('-','').ToLowerInvariant() }finally{$s.Dispose()} }
function Run($exe,$arguments) {
 $i=New-Object Diagnostics.ProcessStartInfo
 $i.FileName=$exe;$i.Arguments=$arguments;$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$i.WindowStyle='Hidden';$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true
 $p=New-Object Diagnostics.Process;$p.StartInfo=$i
 try {
  [void]$p.Start();$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync()
  if (!$p.WaitForExit(60000)) { $p.Kill(); throw 'Fixture timeout' };$p.WaitForExit()
  [pscustomobject]@{exit=$p.ExitCode;stdout=$o.Result;stderr=$e.Result}
 } finally {$p.Dispose()}
}
# Scheduled-task commands are deliberately shadowed; NEVER call real registration.
$script:registrations=0
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) [pscustomobject]@{Execute=$Execute;Argument=$Argument;WorkingDirectory=$WorkingDirectory} }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User,[switch]$Once,$At,$RepetitionInterval) [pscustomobject]@{AtLogOn=[bool]$AtLogOn;User=$User;Once=[bool]$Once;RepetitionInterval=$RepetitionInterval;Repetition=[pscustomobject]@{StopAtDurationEnd=$true}} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) [pscustomobject]@{UserId=$UserId;LogonType=$LogonType;RunLevel=$RunLevel} }
function New-ScheduledTaskSettingsSet { param($MultipleInstances,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,[switch]$StartWhenAvailable,$RestartCount,$RestartInterval,$ExecutionTimeLimit) $PSBoundParameters }
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Principal,$Settings,$Description,[switch]$Force) $script:registrations++;$script:registered=$PSBoundParameters }
try {
 $inputs=@()
 # Keep owned fixture executable paths below legacy CreateProcess MAX_PATH.
 $fixture=Join-Path $base 'c space'
 [IO.Directory]::CreateDirectory($fixture)|Out-Null
 Copy-Item -LiteralPath (Join-Path $sourceRoot 'Install-NimbusStartup.ps1') -Destination $fixture
 Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts') -Destination $fixture -Recurse
 $installer=Join-Path $fixture 'Install-NimbusStartup.ps1'
 . $installer | Out-Null
 Check 'compile-and-register-stub' ($script:registrations -eq 1) $script:registered.Action
 $exe=$script:registered.Action.Execute
 Assert-NimbusGui $exe
 Check 'GUI-subsystem-2' $true (Hash $exe)
 Check 'task-policy' ($script:registered.Settings.MultipleInstances -eq 'IgnoreNew' -and $script:registered.Settings.RestartCount -eq 3 -and $script:registered.Trigger.Count -eq 2 -and $script:registered.Trigger[1].RepetitionInterval.TotalMinutes -eq 1 -and $script:registered.Trigger[0].AtLogOn -and !$script:registered.Trigger[1].Repetition.StopAtDurationEnd -and $script:registered.Principal.RunLevel -eq 'Limited') $script:registered
 . $installer | Out-Null
 Check 'reinstall-existing-binary-preserved' ((Test-Path -LiteralPath $exe) -and $script:registered.Action.Execute -eq $exe -and $script:registrations -eq 2) (Hash $exe)
 foreach($case in @(@{name='success';code=0},@{name='exit37';code=37},@{name='intent-stop';code=0})) {
  $child='param([switch]$Foreground,[switch]$Automatic)'+[Environment]::NewLine+'if (!$Foreground -or !$Automatic) { exit 99 }'+[Environment]::NewLine
  $child+='[Console]::Out.WriteLine("Nimbus automatic start is suspended by its stop request.")'+[Environment]::NewLine
  $child+='for($i=0;$i -lt 20000;$i++){[Console]::Out.WriteLine("stdout drainage");[Console]::Error.WriteLine("stderr drainage")}'+[Environment]::NewLine+('exit '+$case.code)
  [IO.File]::WriteAllText((Join-Path $fixture 'Start-Nimbus.ps1'),$child)
  $r=Run $exe ('"'+$fixture+'"')
  $receipt=Get-Content -Raw -LiteralPath (Join-Path $fixture 'data\host-tools\nimbus-hidden-start\last-run.json')|ConvertFrom-Json
  Check $case.name ($r.exit -eq $case.code -and $receipt.exitCode -eq $case.code -and $receipt.stdoutCharacters -gt 200000 -and $receipt.stderrCharacters -gt 200000 -and $receipt.intentionalStop) @{process=$r;receipt=$receipt}
 }
 Remove-Item -LiteralPath (Join-Path $fixture 'Start-Nimbus.ps1')
 $r=Run $exe ('"'+$fixture+'"')
 Check 'missing-child' ($r.exit -eq 1) $r
 $other=Join-Path $base 'fixtures\different path with spaces'
 [IO.Directory]::CreateDirectory((Join-Path $other 'data\host-tools\nimbus-hidden-start'))|Out-Null
 [IO.File]::WriteAllText((Join-Path $other 'Start-Nimbus.ps1'),'param([switch]$Foreground,[switch]$Automatic); if($Foreground -and $Automatic){exit 37}; exit 99')
 $r=Run $exe ('"'+$other+'"')
 Check 'different-checkout-path' ($r.exit -eq 37) $r
 $r=Run $exe ''
 Check 'missing-root' ($r.exit -eq 1) $r
 $parentPath=$env:PSModulePath
 try {
  $coreModules=$env:NIMBUS_TEST_CORE_MODULES
  if (!$coreModules) {
   $coreCommand=Get-Command pwsh.exe -ErrorAction SilentlyContinue
   if ($coreCommand) { $coreModules=Join-Path (Split-Path $coreCommand.Source) 'Modules' }
  }
  if (!$coreModules -or !(Test-Path -LiteralPath (Join-Path $coreModules 'Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'))) { throw 'Actual PowerShell Core modules are required for this regression fixture' }
  $env:PSModulePath=$coreModules+';'+(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules')
  $inherited=$env:PSModulePath
  $native='param([switch]$Foreground,[switch]$Automatic); $ErrorActionPreference="Stop"; $h=Get-FileHash -LiteralPath $PSCommandPath; $s=Get-AuthenticodeSignature -LiteralPath ($PSHOME+"\powershell.exe"); if($h.Hash.Length -ne 64 -or $s.Status -ne "Valid"){exit 98}; [IO.File]::WriteAllText((Join-Path $PSScriptRoot "native-ok.txt"),$h.Hash); exit 0'
  [IO.File]::WriteAllText((Join-Path $fixture 'Start-Nimbus.ps1'),$native)
  $r=Run $exe ('"'+$fixture+'"')
  Check 'native-modules-under-Core-inheritance' ($r.exit -eq 0 -and (Test-Path (Join-Path $fixture 'native-ok.txt'))) $r
  Check 'caller-environment-unchanged' ($env:PSModulePath -ceq $inherited) $inherited
 } finally { $env:PSModulePath=$parentPath }
 $id='a'*32
 $rejected=0
 foreach($bad in @($buildRoot,(Join-Path $buildRoot '..\outside'),(Join-Path $buildRoot ($id+'x')))) {
  try { Assert-NimbusStage $buildRoot $bad $id } catch { $rejected++ }
 }
 Check 'unsafe-cleanup-paths-rejected' ($rejected -eq 3) $rejected
 $before=$script:registrations
 $src=Join-Path $fixture 'scripts\startup\HiddenStart.cs'
 $saved=[IO.File]::ReadAllText($src)
 [IO.File]::WriteAllText($src,'invalid C#')
 $failed=$false
 try { . $installer | Out-Null } catch {$failed=$true}
 Check 'compile-failure-preserves-task-and-old-binary' ($failed -and $script:registrations -eq $before -and (Test-Path -LiteralPath $exe)) 'No registration after compilation failure'
 [IO.File]::WriteAllText($src,$saved)
 $inputs | ForEach-Object { $inputPath=$_; $h=Hash $inputPath; $baseline=Get-Content -Raw (Join-Path $base 'before-hashes.json')|ConvertFrom-Json; $expected=($baseline|Where-Object path -eq $inputPath).sha256; Check ('input-unchanged: '+$_) ($h -eq $expected) $h }
} catch { $failure=$_.ToString() } finally {
 [pscustomobject]@{at=[DateTime]::UtcNow.ToString('o');count=$results.Count;passed=@($results|Where-Object pass).Count;failed=@($results|Where-Object {!$_.pass}).Count;error=$failure;results=@($results.ToArray())} | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $base 'tests.json') -Encoding UTF8
}
if($failure){Write-Error $failure;exit 1};exit 0
