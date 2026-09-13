// Compiled with the Windows .NET Framework compiler as a GUI-subsystem executable.
// The job owns the whole server process tree so stopping the task cannot orphan it.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

class SocketAgentLauncher {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public int cb; public string reserved, desktop, title;
        public int x, y, width, height, xChars, yChars, fill, flags;
        public short showWindow, reservedSize;
        public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long processTime, jobTime; public uint flags;
        public UIntPtr minWorkingSet, maxWorkingSet;
        public uint activeProcesses; public UIntPtr affinity;
        public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits basic; public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry {
        public uint size, usage, pid;
        public UIntPtr heap;
        public uint module, threads, parentPid;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string executable;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);

    static IntPtr OpenParentProcess() {
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
        if (snapshot == new IntPtr(-1)) throw new Win32Exception();
        try {
            ProcessEntry entry = new ProcessEntry();
            entry.size = (uint)Marshal.SizeOf(entry);
            if (Process32First(snapshot, ref entry)) {
                do {
                    if (entry.pid == GetCurrentProcessId()) {
                        IntPtr parent = OpenProcess(0x00100000, false, entry.parentPid); // SYNCHRONIZE only
                        if (parent == IntPtr.Zero) throw new Win32Exception();
                        return parent;
                    }
                } while (Process32Next(snapshot, ref entry));
            }
            throw new InvalidOperationException("Could not identify the legacy supervisor parent");
        } finally { CloseHandle(snapshot); }
    }

    static int Main(string[] args) {
        IntPtr job = IntPtr.Zero;
        IntPtr parentProcess = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo();
        string cwd = AppDomain.CurrentDomain.BaseDirectory;
        try {
            if (args.Length == 2 && args[0] == "--hide-parent-console") {
                // Task Scheduler can terminate only the old cmd.exe action.
                // Watch that exact parent so its launcher cannot outlive it.
                parentProcess = OpenParentProcess();
                // Compatibility for old tasks whose ACL prevents an unelevated migration.
                // Only this explicit batch-wrapper invocation hides its owning console.
                if (AttachConsole(UInt32.MaxValue)) {
                    IntPtr console = GetConsoleWindow();
                    if (console != IntPtr.Zero) ShowWindow(console, 0);
                    FreeConsole();
                }
                args = new string[] { args[1] };
            }
            if (args.Length != 1 || !File.Exists(args[0]) || Path.GetExtension(args[0]) != ".bat")
                throw new ArgumentException("Expected an existing SocketAgent batch file");
            string script = Path.GetFullPath(args[0]);
            cwd = Path.GetDirectoryName(script);
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            ExtendedLimits limits = new ExtendedLimits();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
            Environment.SetEnvironmentVariable("SOCKETAGENT_SUPERVISED", "1");
            string cmd = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
            StartupInfo startup = new StartupInfo();
            startup.cb = Marshal.SizeOf(startup);
            // Start suspended, assign ownership, then run. No console is ever allocated.
            if (!CreateProcess(cmd, new StringBuilder("\"" + cmd + "\" /d /s /c \"\"" + script + "\"\""),
                IntPtr.Zero, IntPtr.Zero, false, 0x08000004, IntPtr.Zero, cwd, ref startup, out child)) throw new Win32Exception();
            if (!AssignProcessToJobObject(job, child.process)) throw new Win32Exception();
            if (ResumeThread(child.thread) == UInt32.MaxValue) throw new Win32Exception();
            if (parentProcess != IntPtr.Zero) {
                uint ended = WaitForMultipleObjects(2, new IntPtr[] { child.process, parentProcess }, false, UInt32.MaxValue);
                if (ended == 1) return 0; // finally closes the job and terminates our process tree
                if (ended != 0) throw new Win32Exception();
            } else if (WaitForSingleObject(child.process, UInt32.MaxValue) != 0) throw new Win32Exception();
            uint code;
            if (!GetExitCodeProcess(child.process, out code)) throw new Win32Exception();
            return unchecked((int)code);
        } catch (Exception error) {
            if (child.process != IntPtr.Zero) TerminateProcess(child.process, 1);
            try { File.AppendAllText(Path.Combine(cwd, "socketagent.log"), "[launcher] " + error + Environment.NewLine); } catch {}
            return 1;
        } finally {
            if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
            if (child.process != IntPtr.Zero) CloseHandle(child.process);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (parentProcess != IntPtr.Zero) CloseHandle(parentProcess);
        }
    }
}
