$ErrorActionPreference = 'Stop'
# Per-user install only. Never launches a backend, changes services or installs prerequisites.
$target = Join-Path $env:LOCALAPPDATA 'Programs\NimbusWindows'
New-Item $target -ItemType Directory -Force | Out-Null
foreach ($name in @('Nimbus.exe','Nimbus.exe.config','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Wpf.dll','WebView2Loader.dll','README.md')) {
    Copy-Item (Join-Path $PSScriptRoot $name) (Join-Path $target $name) -Force
}
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Nimbus.lnk'))
$link.TargetPath = Join-Path $target 'Nimbus.exe'
$link.WorkingDirectory = $target
$link.Save()
Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show("Nimbus installed for this user. Open Nimbus from Start. No backend was started.","Nimbus") | Out-Null
