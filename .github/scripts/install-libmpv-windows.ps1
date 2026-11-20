# The libmpv the Windows build links against: a pinned dev archive, its checksum, and the MSVC
# import library the archive does not ship. Two jobs need it, so it lives here rather than being
# copied into the second one. See BACKLOG.md M0.2 and M0.3.
$ErrorActionPreference = "Stop"
$file = "mpv-dev-x86_64-20260809-git-dd5d17d328.7z"
$sha  = "c6aebf40bb722efe79090bfeb61e68625f0837770347e5a8b610aef78900cf12"
$dir  = "$env:RUNNER_TEMP\mpv-dev"
# SourceForge keeps every weekly build; the GitHub release the old pin used was pruned (N176).
# The Wget user agent gets the archive itself instead of SourceForge's HTML download page.
Invoke-WebRequest -Uri "https://downloads.sourceforge.net/project/mpv-player-windows/libmpv/$file" -UserAgent "Wget" -MaximumRetryCount 3 -RetryIntervalSec 10 -OutFile mpv-dev.7z
if ((Get-FileHash mpv-dev.7z -Algorithm SHA256).Hash -ne $sha.ToUpper()) { throw "libmpv archive checksum mismatch" }
# $ErrorActionPreference does not cover a native command's exit code, so a failed extraction
# would surface below as "found 0 mpv_* exports", which names the wrong thing.
7z x mpv-dev.7z -o"$dir" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "7z could not extract $file (exit $LASTEXITCODE)" }

# MSVC import library: the archive ships only a MinGW .dll.a, so build mpv.lib from the DLL exports.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs    = & $vswhere -latest -products * -property installationPath
$tools = Get-ChildItem "$vs\VC\Tools\MSVC\*\bin\Hostx64\x64" | Select-Object -Last 1
$dumpbin = Join-Path $tools.FullName "dumpbin.exe"
$libexe  = Join-Path $tools.FullName "lib.exe"
$names = & $dumpbin /exports "$dir\libmpv-2.dll" |
  Select-String -Pattern '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]{8}\s+(mpv_\S+)' |
  ForEach-Object { $_.Matches[0].Groups[1].Value }
if ($names.Count -lt 50) { throw "expected at least 50 mpv_* exports, found $($names.Count)" }
if ($names -notcontains "mpv_create") { throw "mpv_create missing from libmpv-2.dll exports" }
@("EXPORTS") + $names | Set-Content "$dir\mpv.def"
& $libexe /def:"$dir\mpv.def" /name:libmpv-2.dll /out:"$dir\mpv.lib" /MACHINE:X64
if (-not (Test-Path "$dir\mpv.lib")) { throw "failed to generate mpv.lib" }

"LIBMPV_LIB_DIR=$dir" | Out-File -Append -Encoding utf8 $env:GITHUB_ENV
"$dir" | Out-File -Append -Encoding utf8 $env:GITHUB_PATH
