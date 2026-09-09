# run-tests.ps1 - test runner with forced timeout exit
# Usage:
#   .\run-tests.ps1                          # run all tests/js/*.test.mjs
#   .\run-tests.ps1 skill-gen-layout         # fuzzy match by filename
#   .\run-tests.ps1 skill-gen-layout,css     # multiple keywords comma-separated
#   .\run-tests.ps1 -Timeout 60              # custom timeout seconds (default 120)
param(
    [string]$Pattern = "",
    [int]$Timeout = 120
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

# Determine which test files to run
if ($Pattern) {
    $keywords = $Pattern -split "," | ForEach-Object { $_.Trim() }
    $files = Get-ChildItem "tests/js/*.test.mjs" | Where-Object {
        $name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
        $keywords | Where-Object { $_ -and $name.Contains($_) }
    }
} else {
    $files = Get-ChildItem "tests/js/*.test.mjs"
}

if (-not $files) {
    Write-Host "[FAIL] No test files matched (pattern: $Pattern)" -ForegroundColor Red
    exit 1
}

$paths = @($files | ForEach-Object { $_.FullName })
Write-Host "[RUN ] $($paths.Count) test file(s), timeout ${Timeout}s:" -ForegroundColor Cyan
$paths | ForEach-Object { Write-Host "       $([System.IO.Path]::GetFileName($_))" }

# Run node --test, redirect output to temp files for reliable capture
$outLog = Join-Path $env:TEMP "neo-test-out.log"
$errLog = Join-Path $env:TEMP "neo-test-err.log"
Remove-Item $outLog -ErrorAction SilentlyContinue
Remove-Item $errLog -ErrorAction SilentlyContinue

$argsList = @("--test") + $paths
$proc = Start-Process -FilePath "node" -ArgumentList $argsList -NoNewWindow -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog

# Wait with timeout
$exited = $proc.WaitForExit($Timeout * 1000)

if (-not $exited) {
    Write-Host "" -NoNewline
    Write-Host "[TIMEOUT] Exceeded ${Timeout}s, force-killing test process..." -ForegroundColor Yellow
    try {
        $pid_ = $proc.Id
        Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $pid_ } | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue
    } catch {}
    if (Test-Path $outLog) {
        Write-Host "--- partial output ---" -ForegroundColor DarkGray
        Get-Content $outLog | ForEach-Object { Write-Host "  $_" }
    }
    Write-Host "[TIMEOUT] Tests did not finish within ${Timeout}s, force terminated." -ForegroundColor Red
    exit 2
}

# Process exited normally - give it a moment to flush output
Start-Sleep -Milliseconds 200

$output = ""
if (Test-Path $outLog) { $output = Get-Content $outLog -Raw }
$errOut = ""
if (Test-Path $errLog) { $errOut = Get-Content $errLog -Raw }

# Print test output
if ($output) { Write-Host $output }
if ($errOut) { Write-Host "--- stderr ---" -ForegroundColor DarkGray; Write-Host $errOut }

# Determine pass/fail from node --test summary line (e.g. "ℹ fail 0")
$failMatch = [regex]::Match($output, "(?m)^\s*\S*\s*fail\s+(\d+)")
if ($failMatch.Success) {
    $failCount = [int]$failMatch.Groups[1].Value
    if ($failCount -eq 0) {
        Write-Host "[PASS ] All tests passed." -ForegroundColor Green
    } else {
        Write-Host "[FAIL ] $failCount test(s) failed." -ForegroundColor Red
        exit 1
    }
} else {
    # No summary found - process may have crashed before completing
    Write-Host "[FAIL ] No test summary in output (process may have crashed)." -ForegroundColor Red
    exit 1
}
