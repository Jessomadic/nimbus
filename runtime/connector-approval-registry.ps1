# Trusted host only. No tool/config endpoint. Directory is independently provisioned.
$ErrorActionPreference='Stop'
$held=New-Object 'Collections.Generic.List[IDisposable]'
try {
 [Held]::Contain()
 $q=[Console]::ReadLine()|ConvertFrom-Json
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $profile=[Environment]::GetFolderPath('UserProfile')
 $dir=[IO.Path]::GetFullPath($q.directory)
 if($dir -cne $q.directory -or -not $dir.StartsWith($profile+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'path'}
 # Hold every ancestor against replacement; reject reparse and hostile mutation.
 $p=$dir;$leaf=$true
 while($p){
  $h=[Held]::CreateFile($p,131200,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
  if($h.IsInvalid){throw 'open'};$held.Add($h);[Held]::Id($h)|Out-Null
  $item=Get-Item -LiteralPath $p -Force
  if($item.Attributes -band 1024){throw 'reparse'}
  $acl=Get-Acl -LiteralPath $p
  $trusted=@($sid,'S-1-5-18','S-1-5-32-544')
  $osRoot=$p -eq [IO.Path]::GetPathRoot([Environment]::SystemDirectory)
  if($osRoot){$trusted+='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'}
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){throw 'owner'}
  foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
   if($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -notin $trusted){
    if($leaf -or (-not ($ace.PropagationFlags -band 2) -and ([int64]$ace.FileSystemRights -band $(if($osRoot){0xD0152}else{0xD0156})))){throw 'acl'}
   }
  }
  $leaf=$false;$parent=[IO.Directory]::GetParent($p);if(!$parent){break};$p=$parent.FullName
 }
 # Exclusive cross-process writer/read lock; contention fails closed.
 $lock=[IO.File]::Open((Join-Path $dir 'lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $held.Add($lock)
 function ReadPrivate($path){
  $item=Get-Item -LiteralPath $path -Force
  if($item.Attributes -band 1024 -or $item.Length -gt 1048576){throw 'file'}
  $acl=Get-Acl -LiteralPath $path
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($sid,'S-1-5-18','S-1-5-32-544')){throw 'file-owner'}
  foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
   if($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544')){throw 'file-acl'}
  }
  return [IO.File]::ReadAllText($path)
 }
 $current=Join-Path $dir 'current.json'
 $history=@(Get-ChildItem -LiteralPath $dir -Filter 'revision-*.json')
 $previous=$null
 if(Test-Path -LiteralPath $current){
  $text=ReadPrivate $current;$previous=$text|ConvertFrom-Json
  $max=($history|ForEach-Object {if($_.Name -notmatch '^revision-([1-9][0-9]*)\.json$'){throw 'history'};[long]$Matches[1]}|Measure-Object -Maximum).Maximum
  if($previous.version -ne 1 -or $previous.revision -ne $max -or $text -cne (ReadPrivate (Join-Path $dir ('revision-'+$max+'.json')))){throw 'rollback'}
 }elseif($history.Count){throw 'incomplete'}
 if($q.action -eq 'read'){
  if(!$previous){throw 'absent'}
  [Console]::Write($text)
 }elseif($q.action -eq 'commit'){
  $n=$q.mapping
  if($n.version -ne 1 -or $n.revision -lt 1 -or $n.revision -ne [long]$n.revision -or !$n.approval -or !$n.records){throw 'schema'}
  if($previous){
   if($n.revision -ne $previous.revision+1 -or $n.approval.revision -lt $previous.approval.revision){throw 'revision'}
   if($n.approval.revision -eq $previous.approval.revision -and ($n.approval|ConvertTo-Json -Compress -Depth 20) -cne ($previous.approval|ConvertTo-Json -Compress -Depth 20)){throw 'approval-change'}
   foreach($old in $previous.records){
    $next=@($n.records|Where-Object {$_.sourceId -ceq $old.sourceId})
    # Tombstones are retained: deletion/reset cannot reuse an older source revision.
    if($next.Count -ne 1 -or $next[0].revision -lt $old.revision){throw 'source-rollback'}
    if($next[0].revision -eq $old.revision -and ($next[0]|ConvertTo-Json -Compress -Depth 20) -cne ($old|ConvertTo-Json -Compress -Depth 20)){throw 'source-change'}
   }
  }elseif($n.revision -ne 1){throw 'initial'}
  $json=$n|ConvertTo-Json -Compress -Depth 30
  function DurableNew($path,$text){
   $f=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
   try{$bytes=[Text.Encoding]::UTF8.GetBytes($text);$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}finally{$f.Dispose()}
  }
  # Write-ahead immutable high-water record; a crash before pointer replacement denies startup.
  DurableNew (Join-Path $dir ('revision-'+$n.revision+'.json')) $json
  $temp=Join-Path $dir ('pending-'+[guid]::NewGuid().ToString('N'))
  DurableNew $temp $json
  if($previous){[IO.File]::Replace($temp,$current,(Join-Path $dir ('previous-'+[guid]::NewGuid().ToString('N'))))}else{[IO.File]::Move($temp,$current)}
  [Console]::Write('committed')
 }else{throw 'action'}
}catch{[Console]::Error.Write('Protected connector credential unavailable');exit 1}
finally{foreach($h in $held){$h.Dispose()}}
