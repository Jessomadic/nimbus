$ErrorActionPreference = 'Stop'
# Per-user install only. Never launches a backend, changes services or installs prerequisites.
$fixture = $env:NIMBUS_TEST_ROOT
if ($fixture) {
 if (![IO.Path]::IsPathRooted($fixture) -or !(Test-Path (Join-Path $fixture '.nimbus-test-fixture'))) { throw 'Invalid fixture root' }
 $target = Join-Path $fixture 'Programs\NimbusWindows'
} else { $target = Join-Path $env:LOCALAPPDATA 'Programs\NimbusWindows' }
New-Item $target -ItemType Directory -Force | Out-Null
foreach ($name in @('Nimbus.exe','Nimbus.exe.config','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Wpf.dll','WebView2Loader.dll','README.md')) {
    Copy-Item (Join-Path $PSScriptRoot $name) (Join-Path $target $name) -Force
}
$shell = New-Object -ComObject WScript.Shell
$shortcut = if ($fixture) { Join-Path $fixture 'Nimbus.lnk' } else { Join-Path ([Environment]::GetFolderPath('Programs')) 'Nimbus.lnk' }
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = Join-Path $target 'Nimbus.exe'
$link.WorkingDirectory = $target
$link.Save()
if ($fixture) { 'Fixture install complete'; exit 0 }
Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show("Nimbus installed for this user. Open Nimbus from Start. No backend was started.","Nimbus") | Out-Null
