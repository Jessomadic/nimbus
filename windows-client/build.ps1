param([string]$WebViewSdk = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\PrivateAssemblies')
$ErrorActionPreference = 'Stop'
$out = Join-Path $PSScriptRoot 'dist'
New-Item $out -ItemType Directory -Force | Out-Null
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$wpf = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\WPF"
foreach ($name in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Wpf.dll','WebView2Loader.dll')) {
  Copy-Item (Join-Path $WebViewSdk $name) $out -Force
}
& $csc /nologo /target:winexe /platform:x64 "/out:$out\Nimbus.exe" /reference:System.dll /reference:System.Core.dll /reference:System.Xaml.dll "/reference:$wpf\WindowsBase.dll" "/reference:$wpf\PresentationCore.dll" "/reference:$wpf\PresentationFramework.dll" "/reference:$out\Microsoft.Web.WebView2.Core.dll" "/reference:$out\Microsoft.Web.WebView2.Wpf.dll" "$PSScriptRoot\NimbusClient.cs"
if ($LASTEXITCODE -ne 0) { throw 'Compilation failed' }
Copy-Item "$PSScriptRoot\Nimbus.exe.config" $out -Force
$p = Start-Process "$out\Nimbus.exe" -ArgumentList '--self-test' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "URL tests failed: $($p.ExitCode)" }
Write-Output 'Build and 14 URL/origin assertions passed.'
