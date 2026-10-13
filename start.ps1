param([switch]$OpenBrowser, [switch]$ServerOnly)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvDir = Join-Path $projectDir '.venv'
$python = Join-Path $venvDir 'Scripts\python.exe'
$dataDir = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'VideoKnowledge'))
$env:VIDEO_KNOWLEDGE_DATA_DIR = $dataDir

function Assert-ExpectedService($status) {
    $reported = [string]$status.data_dir
    if (-not $reported -or -not [string]::Equals(
        [System.IO.Path]::GetFullPath($reported), $dataDir,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "端口 8765 上的知点服务未使用正式数据目录 $dataDir。请关闭占用该端口的旧服务后重新启动。"
    }
}

if (-not (Test-Path -LiteralPath $python)) {
    py -3 -m venv $venvDir
}

& $python -c 'import fastapi, uvicorn, httpx, yt_dlp, imageio_ffmpeg' *> $null
if ($LASTEXITCODE -ne 0) {
    & $python -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple -r (Join-Path $projectDir 'requirements.txt')
    if ($LASTEXITCODE -ne 0) {
        & $python -m pip install -r (Join-Path $projectDir 'requirements.txt')
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
}

Set-Location $projectDir
$url = 'http://127.0.0.1:8765/'
if ($OpenBrowser -or $ServerOnly) {
    $ready = $false
    try {
        $status = Invoke-RestMethod -Uri ($url + 'api/status') -TimeoutSec 2 -ErrorAction Stop
        Assert-ExpectedService $status
        $ready = $true
    } catch {
        if ($_.Exception.Message -like '端口 8765 上的知点服务*') { throw }
    }
    if (-not $ready) {
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
        $logPath = Join-Path $dataDir 'server.log'
        $errorPath = Join-Path $dataDir 'server-error.log'
        try {
            $probePath = Join-Path $dataDir '.write-test'
            [System.IO.File]::WriteAllText($probePath, '')
            Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
        } catch {
            # Some existing installations have read-only log files. Keep startup usable.
            $logPath = Join-Path $projectDir 'server.log'
            $errorPath = Join-Path $projectDir 'server-error.log'
        }
        $process = Start-Process -FilePath $python -ArgumentList '-m', 'uvicorn', 'server.app:app', '--host', '127.0.0.1', '--port', '8765' -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errorPath -PassThru
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Seconds 1
            try {
                $status = Invoke-RestMethod -Uri ($url + 'api/status') -TimeoutSec 2 -ErrorAction Stop
                Assert-ExpectedService $status
                $ready = $true
                break
            } catch {
                if ($_.Exception.Message -like '端口 8765 上的知点服务*') { throw }
                if ($process.HasExited) { break }
            }
        }
        if (-not $ready) { throw "服务启动失败。请查看 $errorPath" }
    }
    if ($OpenBrowser) {
        try {
            $edgePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
            if (-not (Test-Path -LiteralPath $edgePath)) {
                $edgePath = Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'
            }
            if (-not (Test-Path -LiteralPath $edgePath)) {
                throw '找不到 Microsoft Edge'
            }
            $edgeProcess = [System.Diagnostics.Process]::Start($edgePath, $url)
            if ($edgeProcess) { $edgeProcess.Close() }
        } catch {
            Write-Warning "服务已启动，但浏览器未能自动打开，请访问 $url"
        }
    }
} else {
    & $python -m uvicorn server.app:app --host 127.0.0.1 --port 8765
}
