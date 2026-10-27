# Locks this checkout to its Windows owner, SYSTEM and local Administrators.
# Do not point this at a parent drive or another application's data directory.
param()
$ErrorActionPreference='Stop'
$nimbusSecureRoot=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
if(-not (Test-Path -LiteralPath (Join-Path $nimbusSecureRoot 'server.js') -PathType Leaf) -or
   -not (Test-Path -LiteralPath (Join-Path $nimbusSecureRoot 'package.json') -PathType Leaf)){
  throw 'Run Secure-Nimbus.ps1 from the Nimbus project directory.'
}
$nimbusIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
$nimbusOwnerSid=(Get-Acl -LiteralPath $nimbusSecureRoot).GetOwner([Security.Principal.SecurityIdentifier]).Value
$nimbusTrustedSids=@($nimbusOwnerSid,'S-1-5-18','S-1-5-32-544') | Select-Object -Unique
$nimbusRootItem=Get-Item -LiteralPath $nimbusSecureRoot -Force
if($nimbusRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'The Nimbus root must be a physical directory.'}
# Enumerate ourselves so directory junctions can never carry an ACL change
# outside this checkout. Links are reported and deliberately not traversed.
$nimbusItems=[Collections.Generic.List[IO.FileSystemInfo]]::new()
$nimbusLinks=[Collections.Generic.List[string]]::new()
$nimbusQueue=[Collections.Generic.Queue[string]]::new()
$nimbusQueue.Enqueue($nimbusSecureRoot)
while($nimbusQueue.Count){
  foreach($nimbusItem in Get-ChildItem -LiteralPath $nimbusQueue.Dequeue() -Force){
    if($nimbusItem.Attributes -band [IO.FileAttributes]::ReparsePoint){$nimbusLinks.Add($nimbusItem.FullName);continue}
    $nimbusItems.Add($nimbusItem)
    if($nimbusItem.PSIsContainer){$nimbusQueue.Enqueue($nimbusItem.FullName)}
  }
}
$nimbusChanges=[Collections.Generic.List[object]]::new()
$nimbusChangedPaths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$nimbusEvidenceDir=Join-Path $nimbusSecureRoot 'data\verification'
New-Item -ItemType Directory -Path $nimbusEvidenceDir -Force | Out-Null
$nimbusReceiptPath=Join-Path $nimbusEvidenceDir ('windows-acl-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+'.json')
function Save-NimbusAclReceipt{
  [ordered]@{root=$nimbusSecureRoot;account=$nimbusIdentity.Name;trustedSids=$nimbusTrustedSids;changes=@($nimbusChanges.ToArray());skippedLinks=@($nimbusLinks.ToArray());verified=$false} |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $nimbusReceiptPath -Encoding utf8
}
function Set-NimbusPrivateAcl([string]$nimbusAclPath,[bool]$nimbusDirectory){
  $nimbusResolved=[IO.Path]::GetFullPath($nimbusAclPath)
  if($nimbusResolved -ne $nimbusSecureRoot -and -not $nimbusResolved.StartsWith($nimbusSecureRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'ACL target escaped the Nimbus root.'}
  $nimbusOldAcl=Get-Acl -LiteralPath $nimbusResolved
  if($nimbusChangedPaths.Add($nimbusResolved)){
    $nimbusChanges.Add([ordered]@{path=$nimbusResolved;sddl=$nimbusOldAcl.Sddl})
    Save-NimbusAclReceipt
  }
  $nimbusNewAcl=if($nimbusDirectory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
  $nimbusNewAcl.SetAccessRuleProtection($true,$false)
  foreach($nimbusSid in $nimbusTrustedSids){
    $nimbusInherit=if($nimbusDirectory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
    $nimbusRule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($nimbusSid),[Security.AccessControl.FileSystemRights]::FullControl,$nimbusInherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $nimbusNewAcl.AddAccessRule($nimbusRule)
  }
  # PowerShell Set-Acl copies all security sections and can demand SACL audit
  # privileges when reapplying a protected DACL. Persist only the modified
  # access rules; changing file access does not require audit privileges.
  $nimbusSecurityItem=Get-Item -LiteralPath $nimbusResolved -Force
  if($PSVersionTable.PSEdition -eq 'Core'){
    [IO.FileSystemAclExtensions]::SetAccessControl($nimbusSecurityItem,$nimbusNewAcl)
  }else{
    $nimbusSecurityItem.SetAccessControl($nimbusNewAcl)
  }
}
function Test-NimbusPrivateAcl([string]$nimbusAclPath){
  $nimbusAcl=Get-Acl -LiteralPath $nimbusAclPath
  $nimbusFullControlSids=[Collections.Generic.HashSet[string]]::new()
  foreach($nimbusRule in $nimbusAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
    if($nimbusRule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $nimbusRule.IdentityReference.Value -notin $nimbusTrustedSids){return $false}
    if($nimbusRule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny -and $nimbusRule.IdentityReference.Value -in $nimbusTrustedSids){return $false}
    if($nimbusRule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
       ($nimbusRule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl -and
       -not ($nimbusRule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){
      [void]$nimbusFullControlSids.Add($nimbusRule.IdentityReference.Value)
    }
  }
  foreach($nimbusSid in $nimbusTrustedSids){if(-not $nimbusFullControlSids.Contains($nimbusSid)){return $false}}
  return $true
}
# Root inheritance automatically fixes ordinary descendants. Explicit or
# protected child ACLs are checked and repaired individually if necessary.
Set-NimbusPrivateAcl $nimbusSecureRoot $true
foreach($nimbusItem in $nimbusItems){
  if(-not (Test-NimbusPrivateAcl $nimbusItem.FullName)){Set-NimbusPrivateAcl $nimbusItem.FullName ([bool]$nimbusItem.PSIsContainer)}
}
$nimbusVerified=Test-NimbusPrivateAcl $nimbusSecureRoot
foreach($nimbusItem in $nimbusItems){if(-not (Test-NimbusPrivateAcl $nimbusItem.FullName)){throw ('Unsafe ACL remains: '+$nimbusItem.FullName)}}
if(-not $nimbusVerified){throw 'The Nimbus root ACL could not be verified.'}
$nimbusReceipt=Get-Content -LiteralPath $nimbusReceiptPath -Raw | ConvertFrom-Json
$nimbusReceipt.verified=$true
$nimbusReceipt | Add-Member -NotePropertyName checkedItems -NotePropertyValue ($nimbusItems.Count+1)
$nimbusReceipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $nimbusReceiptPath -Encoding utf8
Write-Output ('Nimbus Windows permissions verified for '+($nimbusItems.Count+1)+' items. Receipt: '+$nimbusReceiptPath)
if($nimbusLinks.Count){Write-Warning ('Skipped '+$nimbusLinks.Count+' filesystem links; their targets require separate permission verification.')}
