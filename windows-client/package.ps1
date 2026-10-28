$ErrorActionPreference = 'Stop'
& "$PSScriptRoot\build.ps1"
$out = Join-Path $PSScriptRoot 'dist'
Copy-Item "$PSScriptRoot\install.ps1","$PSScriptRoot\README.md" $out -Force
$files = @('Nimbus.exe','Nimbus.exe.config','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Wpf.dll','WebView2Loader.dll','install.ps1','README.md')
$strings = for($i=0;$i -lt $files.Count;$i++){ ("FILE{0}={1}" -f $i,$files[$i]) }
$entries = for($i=0;$i -lt $files.Count;$i++){ "%FILE$i%=" }
$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=Install Nimbus for the current user? Requires existing .NET Framework 4.8 and WebView2.
DisplayLicense=
FinishMessage=
TargetName=$out\NimbusSetup.exe
FriendlyName=Nimbus Windows Client
AppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
$($strings -join "`r`n")
[SourceFiles]
SourceFiles0=$out\
[SourceFiles0]
$($entries -join "`r`n")
"@
$sedPath = Join-Path $out 'NimbusSetup.sed'
Set-Content $sedPath $sed -Encoding ASCII
$p = Start-Process "$env:WINDIR\System32\iexpress.exe" -ArgumentList @('/N','/Q', $sedPath) -WindowStyle Hidden -Wait -PassThru
if ($p.ExitCode -ne 0 -or !(Test-Path "$out\NimbusSetup.exe")) { throw "IExpress failed: $($p.ExitCode)" }
foreach ($name in @('Nimbus.exe','NimbusSetup.exe')) { & certutil.exe -hashfile (Join-Path $out $name) SHA256; if ($LASTEXITCODE -ne 0) { throw 'Hash failed' } }
