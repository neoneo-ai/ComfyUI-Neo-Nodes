# 跑 Neo Studio 的 Python 单测。
# 用法：tests\run-tests.ps1                     跑全部（分进程：桌面端与内核插件的桩族互不相容）
#       tests\run-tests.ps1 skill-gen-layout    跑 tests\skills 下匹配的脚本
param([string]$Name = "")
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Python = if (Test-Path "$Root\..\python\python.exe") { "$Root\..\python\python.exe" } else { "python" }

if ($Name) {
    $script = Get-ChildItem "$Root\tests\skills" -Filter "$Name*" -Recurse -Include *.ps1,*.py -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $script) { "找不到测试：$Name"; exit 1 }
    if ($script.Extension -eq '.ps1') { & $script.FullName } else { & $Python $script.FullName }
    exit $LASTEXITCODE
}

# 桌面端用例要真实 folder_paths，节点用例要桩掉的 comfy；分进程跑，谁也不把桩留给对方。
$fail = 0
foreach ($suite in @('studio/tests', 'app/tests')) {
    "===== $suite ====="
    & $Python -m pytest (Join-Path $Root $suite) -q
    if ($LASTEXITCODE -ne 0) { $fail = 1 }
}
exit $fail

