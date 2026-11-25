# Trusted host provisioning entrypoint, never a connector tool. Run only from the
# existing trusted Nimbus host. Approval is independent of addon-supplied JSON.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Artifact)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeApprovalProfile {
 [DllImport("userenv.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern bool GetUserProfileDirectory(IntPtr token, StringBuilder path, ref uint size);
}
'@
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User
[uint32]$size=32768
$profile=New-Object Text.StringBuilder 32768
if(-not [NativeApprovalProfile]::GetUserProfileDirectory($identity.Token,$profile,[ref]$size)){throw 'native-profile'}
# No existing ACL is edited. Use unpredictable NEW dedicated profile directory.
$dir=Join-Path $profile.ToString() ('NimbusNativeApproval-'+[guid]::NewGuid().ToString('N'))
$security=New-Object Security.AccessControl.DirectorySecurity
$security.SetOwner($sid)
$security.SetAccessRuleProtection($true,$false)
foreach($s in @($sid.Value,'S-1-5-18','S-1-5-32-544')){
 $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
 (New-Object Security.Principal.SecurityIdentifier($s)),
 'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
# Validate the whole chain BEFORE creating/copying anything. Conservative rule
# intentionally retains unsafe-root rejection; no TrustedInstaller exception.
$osRoot=[IO.Path]::GetPathRoot([Environment]::SystemDirectory)
$p=$profile.ToString()
while($p){
 $item=Get-Item -LiteralPath $p -Force
 if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'approval-chain-reparse'}
 $acl=Get-Acl -LiteralPath $p
 $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
 $trusted=@($sid.Value,'S-1-5-18','S-1-5-32-544')
 $rootRole=($p -eq $osRoot -and $null -eq [IO.Directory]::GetParent($p))
 if($rootRole){$trusted+= 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'}
 if($owner -notin $trusted){throw 'approval-chain-owner'}
 foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
  if($ace.AccessControlType -eq 'Allow' -and
     $ace.IdentityReference.Value -notin $trusted -and
     -not ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and
     ([int64]$ace.FileSystemRights -band $(if($rootRole){0xD0152}else{0xD0156}))){throw 'approval-chain-mutation'}
 }
 $parent=[IO.Directory]::GetParent($p); if($null -eq $parent){break};$p=$parent.FullName
}
# The host deliberately approves these exact build bytes, not a hash supplied
# by the module itself. This receipt alone never authorizes LoadLibrary.
$source=[IO.File]::Open($Artifact,'Open','Read','Read')
try{
 [IO.Directory]::CreateDirectory($dir,$security)|Out-Null
 $target=Join-Path $dir 'bridge.node'
 $dest=[IO.File]::Open($target,'CreateNew','Write','None')
 try{$source.CopyTo($dest);$dest.Flush($true)}finally{$dest.Dispose()}
 $hash=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
 # Separate protected host approval record, not adjacent untrusted build JSON.
 $record=Join-Path $dir 'host-approval.txt'
 [IO.File]::WriteAllText($record,"NimbusNativeApprovalV1`n$hash`n")
 [pscustomobject]@{state='provisioned-not-loadable';directory=$dir;sha256=$hash;
   limitation='Held-handle pre-load verifier and native policy acceptance required'}|ConvertTo-Json -Compress
}finally{$source.Dispose();$identity.Dispose()}
