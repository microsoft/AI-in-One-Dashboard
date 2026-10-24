// Starts the AI in One installer from a single download. The exe carries Node.js, the installer
// and everything it deploys as one zip; the first run unpacks it under
// %LOCALAPPDATA%\AIInOne\<version>-<hash>, later runs of the same download start at once.
// With no arguments it opens the installer in the browser. Anything else goes to the installer
// as typed, so "AIInOneInstaller.exe status" works from a terminal too.
//
// Compiled by packaging/build-exe.js with the C# 5 compiler in the .NET Framework, which every
// supported Windows has, so keep to C# 5.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Threading;

// Some installed packages nest past Windows' 260-character path limit once unpacked. Targeting
// .NET Framework 4.6.2 lets the file APIs take extended-length (\\?\) paths, which don't have it.
[assembly: TargetFramework(".NETFramework,Version=v4.6.2", FrameworkDisplayName = ".NET Framework 4.6.2")]

internal static class Launcher
{
    private const string HomeFolder = "AIInOne";
    private const string WorkFolder = "AI in One";
    private const string Marker = ".unpacked";
    private const string Partial = ".partial-";
    private const int Cancelled = 130;
    private const int ControlCExit = unchecked((int)0xC000013A);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetConsoleProcessList(uint[] processList, uint processCount);

    [DllImport("kernel32.dll")]
    private static extern uint SetThreadExecutionState(uint flags);

    private const uint EsContinuous = 0x80000000;
    private const uint EsSystemRequired = 0x00000001;
    // Keeps the PC from sleeping until it's reset. The display can still turn off.
    internal const uint AwakeFlags = EsContinuous | EsSystemRequired;

    // Asks Windows not to sleep while the installer runs, or lets it sleep again. False if Windows refused.
    internal static bool KeepAwake(bool on)
    {
        return SetThreadExecutionState(on ? AwakeFlags : EsContinuous) != 0;
    }

    private static int Main(string[] args)
    {
        // Double-clicked: this window closes with the installer, so pause on a failure to show it.
        bool ownWindow = OwnsConsole();
        int code;
        try
        {
            try { Console.Title = "AI in One installer"; }
            catch (IOException) { }
            code = Run(args);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine("The installer couldn't start: " + e.Message);
            code = 1;
        }
        if (ownWindow && code != 0 && code != Cancelled && code != ControlCExit)
        {
            Console.Error.WriteLine();
            Console.Error.Write("Press Enter to close this window.");
            try { Console.ReadLine(); } catch (IOException) { }
        }
        return code;
    }

    private static int Run(string[] args)
    {
        string id = ReadText("payload-id.txt").Trim();
        string home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), HomeFolder);
        string root = Path.Combine(home, id);
        if (!File.Exists(Path.Combine(root, Marker))) Unpack(root);
        RemoveOtherVersions(home, id);

        // The install record lives here, so every version of the download finds it.
        string work = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), WorkFolder);
        Directory.CreateDirectory(work);

        string nodeDir = Path.Combine(root, "node");
        string script = Path.Combine(root, "f", "installer", "bin", "aio-install.js");
        ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(nodeDir, "node.exe"), Quote(script) + " " + (args.Length == 0 ? "--ui" : JoinArgs(args)));
        psi.UseShellExecute = false;
        psi.WorkingDirectory = work;
        psi.EnvironmentVariables["PATH"] = nodeDir + ";" + Environment.GetEnvironmentVariable("PATH");
        psi.EnvironmentVariables["AI_IN_ONE_EXE"] = "1";

        // Ctrl+C reaches the installer too; wait for it to finish cleaning up.
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; };
        // A PC that sleeps part way through setup stops it, so stay awake until the installer exits.
        KeepAwake(true);
        try
        {
            Process started;
            try { started = Process.Start(psi); }
            catch (Win32Exception e)
            {
                if (!BlockedByPolicy(e.NativeErrorCode)) throw;
                throw new InvalidOperationException(PolicyMessage(psi.FileName));
            }
            using (Process p = started)
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        finally
        {
            KeepAwake(false);
        }
    }

    private const string Docs = "https://github.com/microsoft/AI-in-One-Dashboard/blob/main/installer/README.md";

    /// <summary>ERROR_ACCESS_DISABLED_BY_POLICY (AppLocker, software restriction) or ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION (App Control).</summary>
    internal static bool BlockedByPolicy(int code)
    {
        return code == 1260 || code == 4551;
    }

    /// <summary>What to do when a device policy blocks the unpacked node.exe.</summary>
    internal static string PolicyMessage(string node)
    {
        return "your organisation's policy blocks the Node.js that comes with it (" + node + "). Don't work around it."
            + " If your IT team offers Node.js, for example in Company Portal, install the x64 LTS version and use the PowerShell route with it: "
            + Docs + "#it-approved-nodejs. Otherwise run the installer in Azure Cloud Shell ("
            + Docs + "#locked-down-tenant--azure-cloud-shell), or ask your IT team.";
    }

    private static void Unpack(string root)
    {
        Console.WriteLine("Unpacking the AI in One installer. This takes a minute the first time...");
        string partial = root + Partial + Process.GetCurrentProcess().Id;
        if (Directory.Exists(partial)) Directory.Delete(Long(partial), true);
        using (Stream s = Resource("payload.zip"))
        using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
        {
            Extract(zip, partial);
        }
        File.WriteAllText(Path.Combine(partial, Marker), DateTime.UtcNow.ToString("o"));
        MoveIntoPlace(partial, root, MoveWaits);
    }

    // Antivirus, backup and sync tools open new files to check them, and the folder can't be renamed
    // until they let go. These waits come to 50 seconds.
    internal static readonly int[] MoveWaits = { 1000, 2000, 3000, 4000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000 };

    /// <summary>Renames the unpacked folder to its final name, waiting between tries while something holds it.</summary>
    internal static void MoveIntoPlace(string partial, string root, int[] waits)
    {
        string marker = Path.Combine(root, Marker);
        for (int attempt = 0; ; attempt++)
        {
            Exception failure;
            try
            {
                // Left half unpacked by an earlier run that was stopped.
                if (Directory.Exists(root) && !File.Exists(marker)) Directory.Delete(Long(root), true);
                Directory.Move(partial, root);
                return;
            }
            catch (IOException e) { failure = e; }
            catch (UnauthorizedAccessException e) { failure = e; }
            // Another copy of the installer unpacked it first.
            if (File.Exists(marker))
            {
                TryDelete(partial);
                return;
            }
            if (attempt >= waits.Length)
            {
                TryDelete(partial);
                throw new IOException(BusyMessage(Path.GetDirectoryName(root), failure.Message), failure);
            }
            if (attempt == 0) Console.WriteLine("Waiting for something, most likely antivirus, to finish checking the unpacked files...");
            Thread.Sleep(waits[attempt]);
        }
    }

    /// <summary>What to do when something holds the unpacked files for longer than the launcher waits.</summary>
    internal static string BusyMessage(string home, string detail)
    {
        return "something kept its files in " + home + " busy, most likely antivirus checking them."
            + " Wait a minute, then run it again. (" + detail + ")";
    }

    /// <summary>Unpacks every entry under dest, through extended-length paths.</summary>
    internal static void Extract(ZipArchive zip, string dest)
    {
        string root = Long(dest);
        Directory.CreateDirectory(root);
        foreach (ZipArchiveEntry entry in zip.Entries)
        {
            string rel = entry.FullName.Replace('/', '\\');
            if (!SafeEntry(rel)) throw new InvalidDataException("This download is damaged (" + entry.FullName + "). Download it again.");
            string path = root + "\\" + rel.TrimEnd('\\');
            if (rel.EndsWith("\\"))
            {
                Directory.CreateDirectory(path);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            using (Stream from = entry.Open())
            using (FileStream to = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16))
            {
                from.CopyTo(to, 1 << 16);
            }
        }
    }

    /// <summary>Whether a zip entry stays inside the folder it unpacks to.</summary>
    internal static bool SafeEntry(string rel)
    {
        if (rel.Length == 0 || rel[0] == '\\' || rel.IndexOf(':') >= 0) return false;
        foreach (string part in rel.TrimEnd('\\').Split('\\'))
        {
            if (part.Length == 0 || part == "." || part == ".." || part.TrimEnd(' ', '.') != part) return false;
        }
        return true;
    }

    /// <summary>The extended-length form of a full path, which can run past 260 characters.</summary>
    internal static string Long(string path)
    {
        string full = Path.GetFullPath(path);
        if (full.StartsWith(@"\\?\")) return full;
        if (full.StartsWith(@"\\")) return @"\\?\UNC\" + full.Substring(2);
        return @"\\?\" + full;
    }

    // The PAX route's state, which its scheduled task runs from: not a version of the installer.
    // installer/src/pax/names.js (KEPT_DIRS) and install.ps1 list the same folders.
    internal static readonly string[] KeptDirs = { "pax", "pax-run", "managed-app" };

    /// <summary>Whether a folder in the home folder is the installer's state rather than an unpacked version.</summary>
    internal static bool Kept(string name)
    {
        foreach (string kept in KeptDirs)
        {
            if (string.Equals(name, kept, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    /// <summary>Removes what earlier versions unpacked, unless they're still running.</summary>
    internal static void RemoveOtherVersions(string home, string id)
    {
        string[] dirs;
        try { dirs = Directory.GetDirectories(home); }
        catch (IOException) { return; }
        catch (UnauthorizedAccessException) { return; }
        foreach (string dir in dirs)
        {
            string name = Path.GetFileName(dir);
            if (name == id || Kept(name)) continue;
            // Another copy may be unpacking right now.
            if (name.Contains(Partial) && Directory.GetLastWriteTimeUtc(dir) > DateTime.UtcNow.AddHours(-1)) continue;
            string doomed = dir;
            try
            {
                // Moving it first fails while any file in it is in use, and leaves nothing half deleted.
                if (!name.StartsWith("~"))
                {
                    doomed = Path.Combine(home, "~" + Guid.NewGuid().ToString("N"));
                    Directory.Move(dir, doomed);
                }
            }
            catch (IOException) { continue; }
            catch (UnauthorizedAccessException) { continue; }
            TryDelete(doomed);
        }
    }

    private static void TryDelete(string dir)
    {
        try { Directory.Delete(Long(dir), true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static bool OwnsConsole()
    {
        try { return GetConsoleProcessList(new uint[4], 4) == 1; }
        catch (EntryPointNotFoundException) { return false; }
    }

    private static Stream Resource(string name)
    {
        Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        if (s == null) throw new InvalidOperationException("This download is damaged (no " + name + "). Download it again.");
        return s;
    }

    private static string ReadText(string name)
    {
        using (StreamReader r = new StreamReader(Resource(name), Encoding.UTF8)) return r.ReadToEnd();
    }

    private static string JoinArgs(string[] args)
    {
        string[] quoted = new string[args.Length];
        for (int i = 0; i < args.Length; i++) quoted[i] = Quote(args[i]);
        return string.Join(" ", quoted);
    }

    /// <summary>Quotes an argument so the C runtime's command-line parsing gives it back unchanged.</summary>
    internal static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
        StringBuilder sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in arg)
        {
            if (ch == '\\')
            {
                slashes++;
                continue;
            }
            sb.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes);
            sb.Append(ch);
            slashes = 0;
        }
        sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }
}
