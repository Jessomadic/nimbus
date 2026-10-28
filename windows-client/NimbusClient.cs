using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

internal static class UrlPolicy {
    internal static bool Try(string value, out Uri uri) {
        uri = null; Uri candidate;
        if (!Uri.TryCreate(value, UriKind.Absolute, out candidate)) return false;
        if (candidate.UserInfo.Length != 0 || candidate.Fragment.Length != 0) return false;
        System.Net.IPAddress ip;
        bool local = candidate.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || (System.Net.IPAddress.TryParse(candidate.Host.Trim('[', ']'), out ip)
                && (ip.Equals(System.Net.IPAddress.Loopback) || ip.Equals(System.Net.IPAddress.IPv6Loopback)));
        if (candidate.Scheme != "https" && !(candidate.Scheme == "http" && local)) return false;
        uri = candidate; return true;
    }
    internal static bool SameOrigin(Uri a, string value) {
        Uri b; return Try(value, out b) && a.Scheme == b.Scheme
            && a.Host.Equals(b.Host, StringComparison.OrdinalIgnoreCase) && a.Port == b.Port;
    }
}
internal sealed class Client : Window {
    readonly TextBox address = new TextBox { MinWidth = 420, Text = "https://nimbus.jessecopas.com" };
    readonly TextBlock status = new TextBlock { Text = "Select the existing Nimbus backend. No server is started.", Margin = new Thickness(8) };
    readonly WebView2 view = new WebView2();
    Uri origin;
    readonly string state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NimbusWindows");
    internal Client() {
        Title = "Nimbus"; Width = 1180; Height = 820; MinWidth = 650; MinHeight = 450;
        var panel = new DockPanel(); var bar = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(8) };
        var connect = new Button { Content = "Connect", Margin = new Thickness(8,0,0,0), Padding = new Thickness(12,4,12,4) };
        bar.Children.Add(address); bar.Children.Add(connect); DockPanel.SetDock(bar, Dock.Top);
        DockPanel.SetDock(status, Dock.Bottom); panel.Children.Add(bar); panel.Children.Add(status); panel.Children.Add(view); Content = panel;
        try { string saved = File.ReadAllText(Path.Combine(state, "backend-url.txt")); Uri u; if (UrlPolicy.Try(saved, out u)) address.Text = u.AbsoluteUri; } catch (IOException) {} catch (UnauthorizedAccessException) {}
        connect.Click += async delegate {
            Uri selected;
            if (!UrlPolicy.Try(address.Text.Trim(), out selected)) { status.Text = "Use HTTPS or literal loopback HTTP; credentials and fragments are not accepted."; return; }
            if (origin != null && !UrlPolicy.SameOrigin(origin, selected.AbsoluteUri)) {
                status.Text = "Close and reopen Nimbus to select another origin."; return;
            }
            connect.IsEnabled = false;
            try {
                if (view.CoreWebView2 == null) {
                    origin = selected;
                    var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(state, "WebView2"));
                    await view.EnsureCoreWebView2Async(env);
                    view.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
                        if (!UrlPolicy.SameOrigin(origin, e.Uri)) { e.Cancel = true; status.Text = "Blocked navigation outside the selected Nimbus origin."; }
                    };
                    view.CoreWebView2.FrameNavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
                        if (!UrlPolicy.SameOrigin(origin, e.Uri)) e.Cancel = true;
                    };
                    view.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; status.Text = "Popup blocked. Use your browser for external links."; };
                    view.CoreWebView2.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
                    view.CoreWebView2.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs e) { e.Cancel = true; status.Text = "Downloads are disabled in this thin client."; };
                    view.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e) {
                        status.Text = e.IsSuccess ? "Connected: " + origin.GetLeftPart(UriPartial.Authority) : "Navigation failed: " + e.WebErrorStatus;
                    };
                    view.CoreWebView2.Settings.AreDevToolsEnabled = false;
                    view.CoreWebView2.Settings.IsWebMessageEnabled = false;
                }
                Directory.CreateDirectory(state); File.WriteAllText(Path.Combine(state, "backend-url.txt"), selected.AbsoluteUri);
                view.CoreWebView2.Navigate(selected.AbsoluteUri);
            } catch (Exception ex) { status.Text = "WebView2 unavailable: " + ex.Message; }
            finally { connect.IsEnabled = true; }
        };
        Closed += delegate { view.Dispose(); };
    }
    [STAThread] static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "--self-test") {
            string[] yes = { "https://nimbus.jessecopas.com", "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787" };
            string[] no = { "http://example.com", "file:///C:/x", "javascript:alert(1)", "https://user:pass@example.com", "http://127.0.0.1.evil.test", "http://192.168.1.1", "https://example.com/#secret" };
            Uri u; foreach (var s in yes) if (!UrlPolicy.Try(s, out u)) return 1;
            foreach (var s in no) if (UrlPolicy.Try(s, out u)) return 2;
            u = new Uri(yes[0]);
            if (!UrlPolicy.SameOrigin(u, yes[0] + "/login") || UrlPolicy.SameOrigin(u, "https://evil.test") || UrlPolicy.SameOrigin(u, "https://nimbus.jessecopas.com:444")) return 3;
            return 0;
        }
        new Application().Run(new Client()); return 0;
    }
}
