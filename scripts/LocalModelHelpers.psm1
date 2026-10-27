function ConvertFrom-NimbusModelJson {
  param([Parameter(Mandatory=$true)][string]$Json)
  # Windows PowerShell 5.1 emits the parsed empty array as one pipeline object.
  # Flatten the parsed collection before a caller captures its output with @().
  $Json | ConvertFrom-Json | ForEach-Object { $_ }
}
Export-ModuleMember -Function ConvertFrom-NimbusModelJson
