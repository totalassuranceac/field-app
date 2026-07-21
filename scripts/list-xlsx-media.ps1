Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead("C:\Users\chris\Downloads\Pricebook_2026-07-17T11_44_59.xlsx")
$imgs = @()
foreach ($e in $z.Entries) {
  if ($e.FullName -match "png|jpg|jpeg|webp|media|Images") {
    $imgs += "$($e.FullName)|$($e.Length)"
  }
}
$imgs | Select-Object -First 40
Write-Output "TOTAL_IMG=$($imgs.Count)"
Write-Output "TOTAL_ENT=$($z.Entries.Count)"
$z.Dispose()
