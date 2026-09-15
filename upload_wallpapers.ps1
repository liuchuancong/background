$ErrorActionPreference = "Stop"

# =========================
# 配置
# =========================
$RepoPath  = "E:\project\background"
$Remote    = "origin"
$Branch    = "master"
$BatchSize = 100

Set-Location $RepoPath

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " GitHub 批量上传工具" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "目录     : $RepoPath"
Write-Host "远程     : $Remote"
Write-Host "分支     : $Branch"
Write-Host "每批文件 : $BatchSize"
Write-Host ""

# =========================
# 检查 Git
# =========================
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "找不到 git"
}

# =========================
# 确认当前分支
# =========================
$currentBranch = (git branch --show-current).Trim()

if ($currentBranch -ne $Branch) {
    Write-Host "当前分支: $currentBranch" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "脚本不会自动切分支。" -ForegroundColor Yellow
    Write-Host "请先执行：git switch master" -ForegroundColor Yellow
    exit 1
}

# =========================
# 检查远程
# =========================
git remote get-url $Remote | Out-Null

# =========================
# 确保 token.txt 不上传
# =========================
$gitignore = Join-Path $RepoPath ".gitignore"

if (-not (Test-Path $gitignore)) {
    New-Item -ItemType File -Path $gitignore | Out-Null
}

$ignoreContent = Get-Content $gitignore -ErrorAction SilentlyContinue

if ($ignoreContent -notcontains "token.txt") {
    Add-Content $gitignore "token.txt"
}

# =========================
# 获取所有未被忽略的文件
# =========================
$files = @(git ls-files --others --exclude-standard)

Write-Host "当前新增未跟踪文件: $($files.Count)" -ForegroundColor Green

# =========================
# 如果有新增文件，开始分批
# =========================
if ($files.Count -gt 0) {

    $totalBatches = [Math]::Ceiling($files.Count / $BatchSize)

    Write-Host ""
    Write-Host "总文件数 : $($files.Count)" -ForegroundColor Cyan
    Write-Host "批次数量 : $totalBatches" -ForegroundColor Cyan
    Write-Host ""

    for ($batch = 0; $batch -lt $totalBatches; $batch++) {

        $start = $batch * $BatchSize
        $end   = [Math]::Min($start + $BatchSize - 1, $files.Count - 1)

        $batchNumber = $batch + 1

        Write-Host ""
        Write-Host "========================================" -ForegroundColor DarkCyan
        Write-Host "第 $batchNumber / $totalBatches 批" -ForegroundColor Cyan
        Write-Host "文件 $($start + 1) - $($end + 1)" -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor DarkCyan

        # 暂存当前批次
        for ($i = $start; $i -le $end; $i++) {

            $file = $files[$i]

            Write-Host "[$($i + 1)/$($files.Count)] $file"

            git add -- "$file"

            if ($LASTEXITCODE -ne 0) {
                throw "git add 失败: $file"
            }
        }

        # 检查暂存区
        $staged = @(git diff --cached --name-only)

        if ($staged.Count -eq 0) {
            Write-Host "本批没有需要提交的文件，跳过。" -ForegroundColor Yellow
            continue
        }

        Write-Host ""
        Write-Host "本批暂存文件: $($staged.Count)" -ForegroundColor Green

        # 提交
        $message = "Batch upload $batchNumber/$totalBatches"

        git commit -m $message

        if ($LASTEXITCODE -ne 0) {
            throw "git commit 失败"
        }

        # 推送
        Write-Host ""
        Write-Host "正在推送第 $batchNumber 批..." -ForegroundColor Cyan

        git push $Remote "${Branch}:${Branch}"

        if ($LASTEXITCODE -ne 0) {
            throw "git push 失败，第 $batchNumber 批停止。"
        }

        Write-Host ""
        Write-Host "第 $batchNumber 批上传完成。" -ForegroundColor Green
    }
}

# =========================
# 检查还有没有未提交文件
# =========================
Write-Host ""
Write-Host "检查剩余文件..." -ForegroundColor Cyan

$remaining = @(git status --short)

if ($remaining.Count -gt 0) {

    Write-Host ""
    Write-Host "发现剩余 Git 状态：" -ForegroundColor Yellow
    $remaining

    Write-Host ""
    Write-Host "为了安全，脚本停止，不进行强制覆盖。" -ForegroundColor Yellow
    exit 1
}

# =========================
# 最终确认
# =========================
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "所有本地文件已经提交并推送完成。" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

Write-Host "准备覆盖 GitHub master。" -ForegroundColor Yellow
Write-Host ""
Write-Host "即将执行：" -ForegroundColor Yellow
Write-Host "git push --force-with-lease $Remote ${Branch}:${Branch}" -ForegroundColor Yellow
Write-Host ""

$answer = Read-Host "确认覆盖远程 master？输入 YES"

if ($answer -ne "YES") {
    Write-Host ""
    Write-Host "已取消。远程 master 没有被覆盖。" -ForegroundColor Yellow
    exit 0
}

# =========================
# 最终覆盖远程 master
# =========================
Write-Host ""
Write-Host "正在覆盖 GitHub master..." -ForegroundColor Cyan

git push --force-with-lease $Remote "${Branch}:${Branch}"

if ($LASTEXITCODE -ne 0) {
    throw "最终覆盖 master 失败"
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "完成！GitHub master 已更新。" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green