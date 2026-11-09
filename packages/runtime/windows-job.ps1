param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.ComponentModel;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;
public static class WorkOsJob {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo { public uint Size; public string Reserved, Desktop, Title; public uint X,Y,XSize,YSize,XChars,YChars,FillAttribute,Flags; public ushort ShowWindow, Reserved2Size; public IntPtr Reserved2, StdInput, StdOutput, StdError; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long UserTime,KernelTime,ThisUserTime,ThisKernelTime; public uint PageFaults,TotalProcesses,ActiveProcesses,TerminatedProcesses; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr limits,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupInfo startup,out ProcessInfo process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out Accounting accounting,uint size,IntPtr length);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int number);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 static void Check(bool value) { if(!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 static string Quote(string value) { var s=new StringBuilder("\""); int slashes=0; foreach(char c in value) { if(c=='\\') { slashes++; continue; } if(c=='\"') { s.Append('\\',slashes*2+1);s.Append(c); } else {s.Append('\\',slashes);s.Append(c);} slashes=0; }s.Append('\\',slashes*2);s.Append('"');return s.ToString(); }
 static string Resolve(string command) { if(!Path.IsPathRooted(command))throw new Exception("An absolute executable path is required");return command; }
 public static int Run(string command,string[] args,string cwd,string stopPath,string proofPath,int parentPid) {
  IntPtr job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero); var p=new ProcessInfo(); bool resumed=false;
  try {
   var limits=new ExtendedLimits(); limits.Basic.Flags=0x2000; int size=Marshal.SizeOf(limits); IntPtr memory=Marshal.AllocHGlobal(size);
   try {Marshal.StructureToPtr(limits,memory,false);Check(SetInformationJobObject(job,9,memory,(uint)size));}finally{Marshal.FreeHGlobal(memory);}
   var startup=new StartupInfo();startup.Size=(uint)Marshal.SizeOf(startup);startup.Flags=0x100;startup.StdInput=GetStdHandle(-10);startup.StdOutput=GetStdHandle(-11);startup.StdError=GetStdHandle(-12);
   Check(SetHandleInformation(startup.StdInput,1,1));Check(SetHandleInformation(startup.StdOutput,1,1));Check(SetHandleInformation(startup.StdError,1,1));
   string application=Resolve(command);var line=new StringBuilder(Quote(application));foreach(string arg in args)line.Append(" "+Quote(arg));
   using(var parent=Process.GetProcessById(parentPid)) {
    if(parent.HasExited)throw new Exception("Worker already exited");
    // Capture a process handle before launching anything, so PID reuse cannot adopt a new worker.
    var parentHandle=parent.Handle;
    Check(CreateProcess(application,line,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref startup,out p));
    Check(AssignProcessToJobObject(job,p.Process));Check(ResumeThread(p.Thread)!=0xffffffff);resumed=true;
    while(true) { uint state=WaitForSingleObject(p.Process,100);if(state==0)break;Check(state==258);if(File.Exists(stopPath)||parent.HasExited)return 124; }
    uint code;Check(GetExitCodeProcess(p.Process,out code));return unchecked((int)code);
   }
  } finally {
   try {
    if(p.Process!=IntPtr.Zero&&!resumed){Check(TerminateProcess(p.Process,125));Check(WaitForSingleObject(p.Process,10000)==0);}
    Check(TerminateJobObject(job,124));
    var deadline=DateTime.UtcNow.AddSeconds(10);Accounting accounting;
    do {Check(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));if(accounting.ActiveProcesses==0)break;if(DateTime.UtcNow>deadline)throw new Exception("Job processes did not stop");Thread.Sleep(20);}while(true);
    File.WriteAllText(proofPath,"stopped");
   } finally {if(p.Thread!=IntPtr.Zero)CloseHandle(p.Thread);if(p.Process!=IntPtr.Zero)CloseHandle(p.Process);CloseHandle(job);}
  }
 }
}
'@
try {
 $request = [System.IO.File]::ReadAllText($RequestPath) | ConvertFrom-Json
 $result = [WorkOsJob]::Run([string]$request.command, [string[]]$request.args, [string]$request.cwd, [string]$request.stopPath, [string]$request.proofPath, [int]$request.parentPid)
 exit $result
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 125 }
