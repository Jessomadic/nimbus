# Nimbus Windows thin client

Issue #5; Windows x64. Native WPF window with Microsoft Edge WebView2, loading the existing Nimbus web application. No backend, ports, bundled server, credentials, or new API. Default HTTPS URL is derived from the repository README (https://nimbus.jessecopas.com); local installations may select http://127.0.0.1:8787 instead. Use the backend's configured canonical HTTPS origin for passkeys. Choosing another origin does not change backend origin/RP configuration.

## Requirements / build
Existing .NET Framework 4.8 and evergreen Microsoft Edge WebView2 Runtime. Build uses the Windows Framework C# compiler and existing Visual Studio WebView2 SDK 1.0.2903.40; no NuGet, runtime, package, or toolchain install.
Run ./build.ps1 in Windows PowerShell, or ./package.ps1 for an unsigned IExpress installer. Override -WebViewSdk on build.ps1 for an existing SDK directory containing Core/Wpf/loader DLLs. The host's .NET 6/8 SDKs were inspected but are not required; Framework avoids another deployed runtime.

dist/Nimbus.exe is portable with its adjacent DLLs/config. NimbusSetup.exe copies those files to %LOCALAPPDATA%/Programs/NimbusWindows and creates a Start menu shortcut. No administrator privileges or auto-start. Installer has not been installed during implementation. Unsigned binaries may trigger SmartScreen; no signing identity was assumed. Installer uses the stock Windows PowerShell process policy override for its bundled script, not a persistent policy change.

## Security / deliberate limits
Enter the existing backend URL and click Connect. Only HTTPS or loopback HTTP is accepted, without embedded credentials/fragments. Navigation and frames remain pinned to that origin, including redirects; popups, downloads, WebView permissions and native web messaging are blocked. External sign-in redirects and links therefore need the regular browser. Certificate validation remains WebView2's default; no certificate bypass or host-object bridge exists. Passwords and passkeys are handled by the unchanged backend and WebView2; no cookies or credentials are imported. WebAuthn is runtime/platform dependent and requires live account acceptance testing, not just a successful native launch.

The client uses its own WebView2 user-data directory at %LOCALAPPDATA%/NimbusWindows/WebView2. Its selected URL is stored alongside it. Close/reopen to change origins. Do not put secrets in URLs. Missing runtime/network failures are displayed in the status line. No automatic network connection occurs before Connect.

Uninstall: close Nimbus, remove the Nimbus Start menu shortcut and %LOCALAPPDATA%/Programs/NimbusWindows. Preserve %LOCALAPPDATA%/NimbusWindows unless intentionally clearing this client's cookies/profile; this is separate from backend data.

## Verification boundary
build.ps1 compiles and executes 14 allow/deny/origin assertions, including IPv6 loopback, non-loopback HTTP, credential URLs, fragments and port changes. Packaging is not installation testing. Native launch and navigation evidence are recorded separately in validation.txt; successful authentication/passkey enrollment and Windows Server unattended operation are not claimed.

WebView2 Core/WPF/loader binaries are Microsoft components from the installed SDK, not authored by Nimbus. Redistribution is subject to Microsoft's WebView2 SDK license: https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.2903.40/License . Existing evergreen runtime is required and is not bundled.
