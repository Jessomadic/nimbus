# Locks this checkout to its Windows owner, SYSTEM and local Administrators.
# Do not point this at a parent drive or another application's data directory.
# -Mode Full checks every item. -Mode Incremental (the default) checks every
# item outside data\, every directory, and every file in a directory changed
# since the last verified scan: the protected root ACL means only the owner,
# SYSTEM or Administrators can add items, and adding, moving or renaming an
# item updates its parent directory's modification time. A weekly Full scan
# covers in-place ACL edits by an administrator.
param([ValidateSet('Full','Incremental')][string]$Mode='Incremental')
$ErrorActionPreference='Stop'
$nimbusStarted=[DateTime]::UtcNow
$nimbusSecureRoot=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
if(-not (Test-Path -LiteralPath (Join-Path $nimbusSecureRoot 'server.js') -PathType Leaf) -or
   -not (Test-Path -LiteralPath (Join-Path $nimbusSecureRoot 'package.json') -PathType Leaf)){
  throw 'Run Secure-Nimbus.ps1 from the Nimbus project directory.'
}
$nimbusEvidenceDir=Join-Path $nimbusSecureRoot 'data\verification'
New-Item -ItemType Directory -Path $nimbusEvidenceDir -Force | Out-Null
function Get-NimbusLastVerified{
  foreach($nimbusFile in Get-ChildItem -LiteralPath $nimbusEvidenceDir -Filter 'windows-acl-*.json' -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 20){
    try{if((Get-Content -LiteralPath $nimbusFile.FullName -Raw | ConvertFrom-Json).verified -eq $true){return $nimbusFile.LastWriteTimeUtc}}catch{}
  }
  return $null
}
# One scan at a time per checkout. A caller that waited behind a scan which
# completed after this caller started has nothing left to check.
$nimbusRootHash=[BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($nimbusSecureRoot.ToLowerInvariant()))).Replace('-','')
$nimbusMutex=[Threading.Mutex]::new($false,'Local\NimbusSecure-'+$nimbusRootHash)
try{[void]$nimbusMutex.WaitOne()}catch [Threading.AbandonedMutexException]{}
try{
$nimbusLastVerified=Get-NimbusLastVerified
if($nimbusLastVerified -and $nimbusLastVerified -ge $nimbusStarted){
  Write-Output ('Nimbus Windows permissions were verified by a concurrent scan at '+$nimbusLastVerified.ToString('o')+'; nothing to repeat.')
  return
}
if($Mode -eq 'Incremental' -and -not $nimbusLastVerified){$Mode='Full'}
$nimbusSince=if($Mode -eq 'Incremental'){$nimbusLastVerified.AddMinutes(-10)}else{$null}
$nimbusDataRoot=Join-Path $nimbusSecureRoot 'data'
$nimbusIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
$nimbusOwnerSid=(Get-Acl -LiteralPath $nimbusSecureRoot).GetOwner([Security.Principal.SecurityIdentifier]).Value
$nimbusTrustedSids=@($nimbusOwnerSid,'S-1-5-18','S-1-5-32-544') | Select-Object -Unique
$nimbusRootItem=Get-Item -LiteralPath $nimbusSecureRoot -Force
if($nimbusRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'The Nimbus root must be a physical directory.'}
# Enumerate ourselves so directory junctions can never carry an ACL change
# outside this checkout. Links are reported and deliberately not traversed.
$nimbusItems=[Collections.Generic.List[IO.FileSystemInfo]]::new()
$nimbusLinks=[Collections.Generic.List[string]]::new()
$nimbusQueue=[Collections.Generic.Queue[IO.DirectoryInfo]]::new()
$nimbusQueue.Enqueue([IO.DirectoryInfo]::new($nimbusSecureRoot))
$nimbusTotal=0
while($nimbusQueue.Count){
  $nimbusDir=$nimbusQueue.Dequeue()
  $nimbusInData=$nimbusDir.FullName -eq $nimbusDataRoot -or $nimbusDir.FullName.StartsWith($nimbusDataRoot+'\',[StringComparison]::OrdinalIgnoreCase)
  # Files in an unchanged data directory keep the inherited protection of that
  # directory; the directory itself is still checked below.
  $nimbusCheckFiles=$Mode -eq 'Full' -or -not $nimbusInData -or $nimbusDir.LastWriteTimeUtc -ge $nimbusSince
  foreach($nimbusItem in $nimbusDir.EnumerateFileSystemInfos()){
    $nimbusTotal++
    if($nimbusItem.Attributes -band [IO.FileAttributes]::ReparsePoint){$nimbusLinks.Add($nimbusItem.FullName);continue}
    if($nimbusItem -is [IO.DirectoryInfo]){$nimbusItems.Add($nimbusItem);$nimbusQueue.Enqueue($nimbusItem);continue}
    if($nimbusCheckFiles -or $nimbusItem.LastWriteTimeUtc -ge $nimbusSince -or $nimbusItem.CreationTimeUtc -ge $nimbusSince){$nimbusItems.Add($nimbusItem)}
  }
}
$nimbusChanges=[Collections.Generic.List[object]]::new()
$nimbusChangedPaths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$nimbusReceiptPath=Join-Path $nimbusEvidenceDir ('windows-acl-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+'.json')
function Save-NimbusAclReceipt{
  [ordered]@{root=$nimbusSecureRoot;account=$nimbusIdentity.Name;trustedSids=$nimbusTrustedSids;mode=$Mode;startedAt=$nimbusStarted.ToString('o');incrementalSince=$(if($nimbusSince){$nimbusSince.ToString('o')}else{$null});totalItems=$nimbusTotal;changes=@($nimbusChanges.ToArray());skippedLinks=@($nimbusLinks.ToArray());verified=$false} |
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
  try{
    $nimbusAcl=Get-Acl -LiteralPath $nimbusAclPath -ErrorAction Stop
  }catch{
    # The tree is snapshotted before ACL verification. Git and other tools can
    # remove transient directories (for example turn-diff captures) meanwhile.
    # Treat only a path now proven absent as gone; preserve access and ACL errors.
    try{
      Get-Item -LiteralPath $nimbusAclPath -Force -ErrorAction Stop | Out-Null
    }catch [System.Management.Automation.ItemNotFoundException]{return $true}
    catch [System.IO.FileNotFoundException]{return $true}
    catch [System.IO.DirectoryNotFoundException]{return $true}
    throw
  }
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
Save-NimbusAclReceipt
# Rewriting an already-correct inheritable root DACL makes Windows re-propagate
# it to every descendant, so the root is only rewritten when it fails the check.
if(-not (Test-NimbusPrivateAcl $nimbusSecureRoot)){Set-NimbusPrivateAcl $nimbusSecureRoot $true}
$nimbusRepaired=[Collections.Generic.List[IO.FileSystemInfo]]::new()
foreach($nimbusItem in $nimbusItems){
  if(-not (Test-NimbusPrivateAcl $nimbusItem.FullName)){Set-NimbusPrivateAcl $nimbusItem.FullName ($nimbusItem -is [IO.DirectoryInfo]);$nimbusRepaired.Add($nimbusItem)}
}
# Items that passed were read once; only repaired items and the root are re-read.
$nimbusVerified=Test-NimbusPrivateAcl $nimbusSecureRoot
foreach($nimbusItem in $nimbusRepaired){if(-not (Test-NimbusPrivateAcl $nimbusItem.FullName)){throw ('Unsafe ACL remains: '+$nimbusItem.FullName)}}
if(-not $nimbusVerified){throw 'The Nimbus root ACL could not be verified.'}
$nimbusReceipt=Get-Content -LiteralPath $nimbusReceiptPath -Raw | ConvertFrom-Json
$nimbusReceipt.verified=$true
$nimbusReceipt | Add-Member -NotePropertyName checkedItems -NotePropertyValue ($nimbusItems.Count+1)
$nimbusReceipt | Add-Member -NotePropertyName repairedItems -NotePropertyValue $nimbusRepaired.Count
$nimbusReceipt | Add-Member -NotePropertyName seconds -NotePropertyValue ([math]::Round(([DateTime]::UtcNow-$nimbusStarted).TotalSeconds,1))
$nimbusReceipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $nimbusReceiptPath -Encoding utf8
Write-Output ('Nimbus Windows permissions verified ('+$Mode+') for '+($nimbusItems.Count+1)+' of '+($nimbusTotal+1)+' items. Receipt: '+$nimbusReceiptPath)
if($nimbusLinks.Count){Write-Warning ('Skipped '+$nimbusLinks.Count+' filesystem links; their targets require separate permission verification.')}
}finally{$nimbusMutex.ReleaseMutex();$nimbusMutex.Dispose()}
