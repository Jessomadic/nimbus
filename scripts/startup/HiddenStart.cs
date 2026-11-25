using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;

// A GUI-subsystem entry point avoids allocating a console before PowerShell can
// apply -WindowStyle Hidden. CREATE_NO_WINDOW also prevents Terminal delegation.
internal static class HiddenStart
{
    private static string Root;
    private static string Receipt;
    private static int Main(string[] args)
    {
        if (args.Length != 1) return 1;
        try { Root = Path.GetFullPath(args[0]); }
        catch { return 1; }
        Receipt = Path.Combine(Root, "data", "host-tools", "nimbus-hidden-start", "last-run.json");
        int childPid = 0, exitCode = 1;
        long stdoutCharacters = 0, stderrCharacters = 0;
        bool alreadySupervised = false, intentionalStop = false;
        string failureType = "";
        DateTime started = DateTime.UtcNow;
        try
        {
            if (!File.Exists(Path.Combine(Root, "Start-Nimbus.ps1"))) throw new FileNotFoundException("Supervisor script missing");
            var info = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -File \"" + Path.Combine(Root, "Start-Nimbus.ps1") + "\" -Foreground -Automatic",
                WorkingDirectory = Root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            // Microsoft about_PSModulePath: remove inherited Core module paths
            // when starting Windows PowerShell; caller environment is untouched.
            info.EnvironmentVariables.Remove("PSModulePath");
            using (var process = new Process { StartInfo = info })
            {
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                    if (e.Data == null) return;
                    stdoutCharacters += e.Data.Length;
                    if (e.Data.Contains("Nimbus is already supervised; automatic recovery left it running.")) alreadySupervised = true;
                    if (e.Data.Contains("Nimbus automatic start is suspended by its stop request.")) intentionalStop = true;
                };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if(e.Data != null) stderrCharacters += e.Data.Length; };
                if (!process.Start()) throw new InvalidOperationException("Process did not start");
                childPid = process.Id;
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                // Remain the scheduled task's foreground owner for the lifetime
                // of the real supervisor; preserve IgnoreNew and retry behavior.
                process.WaitForExit();
                exitCode = process.ExitCode;
            }
        }
        catch (Exception e) { failureType = e.GetType().Name; }
        try
        {
            string json = "{\"startedAt\":\"" + started.ToString("o", CultureInfo.InvariantCulture) +
                "\",\"endedAt\":\"" + DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) +
                "\",\"launcherPid\":" + Process.GetCurrentProcess().Id + ",\"childPid\":" + childPid +
                ",\"exitCode\":" + exitCode + ",\"alreadySupervised\":" + alreadySupervised.ToString().ToLowerInvariant() +
                ",\"intentionalStop\":" + intentionalStop.ToString().ToLowerInvariant() +
                ",\"stdoutCharacters\":" + stdoutCharacters + ",\"stderrCharacters\":" + stderrCharacters +
                ",\"failureType\":\"" + failureType + "\"}";
            File.WriteAllText(Receipt, json, new UTF8Encoding(false));
        }
        catch { /* Receipt failure must not hide the actual child exit code. */ }
        return exitCode;
    }
}
