$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class Held {
 // Keep the sole, non-inheritable job handle until process exit. Kernel closure
 // kills this verifier and ALL descendants, including on verifier termination.
 static IntPtr job;
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr p,uint n);
 [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 public static void Contain(){
  job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Exception("job");
  IntPtr p=Marshal.AllocHGlobal(144);
  try{for(int i=0;i<144;i++)Marshal.WriteByte(p,i,0);Marshal.WriteInt32(p,16,0x2000);
   if(!SetInformationJobObject(job,9,p,144)||!AssignProcessToJobObject(job,GetCurrentProcess()))throw new Exception("job");
  }finally{Marshal.FreeHGlobal(p);}
 }
 [DllImport("kernel32.dll")] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int c,byte[] p,uint n);
 public static string NativeId(SafeFileHandle h){
  byte[] b=new byte[24];if(!GetFileInformationByHandleEx(h,18,b,24))throw new Exception("native-id");
  return BitConverter.ToUInt64(b,0).ToString("x16")+":"+BitConverter.ToString(b,8,16).Replace("-","").ToLowerInvariant();
 }

 public static System.Threading.Tasks.Task<string> CancelRead(){return System.Threading.Tasks.Task.Run(()=>Console.ReadLine());}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 public static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr sa,uint d,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)]
 public static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [StructLayout(LayoutKind.Sequential,Pack=4)] public struct Info {
 public uint attr; public long creation,access,write; public uint volume,high,low,links,indexHigh,indexLow;
 }
 public static string Id(SafeFileHandle h) { Info i; if(!GetFileInformationByHandle(h,out i)||(i.attr&1024)!=0)throw new Exception("identity");
 return i.volume+":"+i.indexHigh+":"+i.indexLow+":"+i.links; }
}
'@
$held=New-Object 'Collections.Generic.List[IDisposable]'
$child=$null
$output=$null
try{
 [Held]::Contain()
 $q=[Console]::ReadLine()|ConvertFrom-Json
 $cancel=[Held]::CancelRead()
 $deadline=[DateTime]::UtcNow.AddSeconds(4)
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 if($q.file -match '["\r\n]' -or $q.binding -notmatch '^S-1-[0-9-]+\|[0-9a-f:|]+$'){throw 'arguments'}
 if($q.ownerSid -ne $sid){throw 'sid'}
 $profile=[Environment]::GetFolderPath('UserProfile')
 $b=$q.bindingV1
 if($b.version -ne 1 -or $b.ownerSid -cne $sid -or $b.runtimeId -cne $q.sha256 -or
    $q.binding -cne (($b.ownerSid,@($b.chain),$b.sha256 | ForEach-Object {$_}) -join '|')){throw 'binding-v1'}
 $ph=[Held]::CreateFile($profile,2147614848,1,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
 if($ph.IsInvalid){throw 'profile'}
 $held.Add($ph)
 if([Held]::NativeId($ph) -cne $b.profileId){throw 'profile-id'}
 $sh=[Held]::CreateFile([IO.Path]::GetDirectoryName($q.file),2147614848,1,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
 if($sh.IsInvalid){throw 'store'}
 $held.Add($sh)
 if([Held]::NativeId($sh) -cne $b.storeId){throw 'store-id'}
 $path=[IO.Path]::GetFullPath($q.artifact)
 if($path -cne $q.artifact -or -not $path.StartsWith($profile+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'path'}
 $parts=New-Object 'Collections.Generic.List[string]'
 $p=$path
 while($p){$parts.Insert(0,$p);$parent=[IO.Directory]::GetParent($p);if(!$parent){break};$p=$parent.FullName}
 $descriptors=@{}
 $identities=New-Object 'Collections.Generic.List[string]'
 foreach($p in $parts){
  $h=[Held]::CreateFile($p,2147614848,1,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
  if($h.IsInvalid){throw 'open'}
  $held.Add($h);$identities.Add([Held]::Id($h))
 }
 if(($identities -join '|') -cne $q.chain){throw 'chain'}
 for($i=$parts.Count-1;$i -ge 0;$i--){
  $a=Get-Acl -LiteralPath $parts[$i]
  $descriptors[$parts[$i]]=$a.Sddl
  $trusted=@($sid,'S-1-5-18','S-1-5-32-544')
  $osRoot=$i -eq 0 -and $parts[$i] -eq [IO.Path]::GetPathRoot([Environment]::SystemDirectory)
  if($osRoot){$trusted+='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'}
  if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){throw 'owner'}
  foreach($ace in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
   if($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -notin $trusted){
    if($i -ge $parts.Count-2){throw 'private'}
    if(-not ($ace.PropagationFlags -band 2) -and ([int64]$ace.FileSystemRights -band $(if($osRoot){0xD0152}else{0xD0156}))){throw 'acl'}
   }
  }
 }
 if((Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($path)) -Force).Count -ne 1){throw 'closure-directory'}
 $stream=New-Object IO.FileStream($held[$held.Count-1],[IO.FileAccess]::Read)
 $bytes=New-Object byte[] $stream.Length
 if($stream.Read($bytes,0,$bytes.Length) -ne $bytes.Length){throw 'read'}
 $hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
 if($hash -cne $q.sha256){throw 'digest'}
 # Independent PE32+ import check before candidate execution. No delay imports.
 $pe=[BitConverter]::ToInt32($bytes,60)
 if([BitConverter]::ToUInt32($bytes,$pe) -ne 17744 -or [BitConverter]::ToUInt16($bytes,$pe+4) -ne 34404 -or [BitConverter]::ToUInt16($bytes,$pe+24) -ne 523){throw 'pe'}
 $sections=[BitConverter]::ToUInt16($bytes,$pe+6);$opt=$pe+24
 $table=$opt+[BitConverter]::ToUInt16($bytes,$pe+20)
 function Offset([uint32]$rva){
  for($j=0;$j -lt $sections;$j++){$s=$table+40*$j;$va=[BitConverter]::ToUInt32($bytes,$s+12);$size=[BitConverter]::ToUInt32($bytes,$s+16)
   if($rva -ge $va -and $rva -lt $va+$size){return ($rva-$va+[BitConverter]::ToUInt32($bytes,$s+20))}
  };throw 'rva'
 }
 if([BitConverter]::ToUInt32($bytes,$opt+112+13*8) -ne 0){throw 'delay'}
 $imp=Offset ([BitConverter]::ToUInt32($bytes,$opt+120))
 $imports=@()
 for($j=0;$j -lt 64;$j++){
  $rva=[BitConverter]::ToUInt32($bytes,$imp+20*$j+12);if(!$rva){break}
  $o=Offset $rva;$end=$o;while($bytes[$end] -ne 0){$end++;if($end-$o -gt 100){throw 'import'}}
  $name=[Text.Encoding]::ASCII.GetString($bytes,$o,$end-$o).ToLowerInvariant()
  if($name -notin @('kernel32.dll','advapi32.dll','userenv.dll','crypt32.dll','bcrypt.dll')){throw 'dependency'}
  $imports+=$name
 }
 if(($imports|Sort-Object) -join ',' -cne $q.imports){throw 'imports'}
 # Only OS dependencies, private empty executable directory, fixed OS CWD/PATH.
 $start=New-Object Diagnostics.ProcessStartInfo
 $start.FileName=$path;$start.Arguments='"'+$q.file+'" "'+$q.binding+'"'
 $start.WorkingDirectory=[Environment]::SystemDirectory
 $start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $start.EnvironmentVariables.Clear()
 $start.EnvironmentVariables['SystemRoot']=[Environment]::GetFolderPath('Windows')
 $start.EnvironmentVariables['PATH']=[Environment]::SystemDirectory
 $child=New-Object Diagnostics.Process;$child.StartInfo=$start
 if($cancel.IsCompleted -or [DateTime]::UtcNow -gt $deadline){throw 'cancel'}
 [Console]::Error.WriteLine('VERIFIED')
 if(!$child.Start()){throw 'start'}
 [Console]::Error.WriteLine('EXECUTED')
 $output=New-Object IO.MemoryStream
 $copy=$child.StandardOutput.BaseStream.CopyToAsync($output)
 $watch=[Diagnostics.Stopwatch]::StartNew()
 while(!$child.WaitForExit(20)){
  if($cancel.IsCompleted -or [DateTime]::UtcNow -gt $deadline){$child.Kill();$child.WaitForExit();throw 'cancel'}
 }
 $copy.GetAwaiter().GetResult()|Out-Null
 if($child.ExitCode -ne 0 -or $output.Length -lt 24 -or $output.Length -gt 65536){throw 'native'}
 for($i=0;$i -lt $parts.Count;$i++){
  if([Held]::Id($held[$i+2]) -cne $identities[$i] -or (Get-Acl -LiteralPath $parts[$i]).Sddl -cne $descriptors[$parts[$i]]){throw 'changed'}
 }
 $result=$output.ToArray()
 try{[Console]::OpenStandardOutput().Write($result,0,$result.Length)}finally{[Array]::Clear($result,0,$result.Length);[Array]::Clear($output.GetBuffer(),0,$output.Capacity)}
}catch{[Console]::Error.WriteLine('DENIED');exit 1}
finally{
 if($child){if(!$child.HasExited){$child.Kill();$child.WaitForExit()};$child.Dispose()}
 if($output){[Array]::Clear($output.GetBuffer(),0,$output.Capacity);$output.Dispose()}
 foreach($h in $held){$h.Dispose()}
}
