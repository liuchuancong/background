<#
.SYNOPSIS
    Batched GitHub uploader for large media repositories.

.DESCRIPTION
    A single 3+ GB commit cannot be pushed over HTTPS: the pack either stalls or
    is rejected, and because the server commits a pack atomically nothing lands,
    so every retry starts from zero. This script splits the unpushed content into
    size-bounded commits and pushes them one at a time, so a dropped connection
    only costs the batch in flight.

    Progress is derived from the remote itself: a batch commit is considered
    done once it is an ancestor of origin/master. That makes a re-run resume
    instead of restarting, with no state file to get out of sync.

    Commit timestamps are pinned to the base commit, so the split is
    deterministic and a re-run rebuilds byte-identical commits rather than
    orphaning work that already uploaded.

.PARAMETER BatchMB
    Target payload per batch, in megabytes. Smaller is safer on a poor link.

.PARAMETER MaxRetries
    Push attempts per batch before giving up for this run.

.PARAMETER Status
    Report the situation and exit without changing anything.

.PARAMETER DryRun
    Show the batch plan without committing or pushing.

.PARAMETER Force
    Allow a final --force-with-lease if the remote diverged.

.PARAMETER NoPush
    Split the history but stop before pushing. Useful to inspect the result.

.PARAMETER NoTune
    Skip the git HTTP settings adjustment.

.EXAMPLE
    .\push-batched.ps1 -Status
.EXAMPLE
    .\push-batched.ps1 -DryRun
.EXAMPLE
    .\push-batched.ps1 -BatchMB 200
#>

[CmdletBinding()]
param(
    [int]$BatchMB = 250,
    [int]$MaxRetries = 5,
    [switch]$Status,
    [switch]$DryRun,
    [switch]$Force,
    [switch]$NoPush,
    [switch]$NoTune
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------------------------------------------------------------- configuration
$RepoPath = $PSScriptRoot
$Remote = 'origin'
$Branch = 'master'
$BatchPrefix = 'chore: upload batch'
$BaseTag = 'refs/tags/push-batched-base'
$MB = 1MB

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host ('=' * 62) -ForegroundColor DarkCyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host ('=' * 62) -ForegroundColor DarkCyan
}

function Write-Kv([string]$Key, $Value, [string]$Color = 'Gray') {
    Write-Host ('  {0,-22} {1}' -f $Key, $Value) -ForegroundColor $Color
}

function Format-Size([double]$Bytes) {
    if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
    return ('{0:N1} MB' -f ($Bytes / 1MB))
}

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    $out = & git @GitArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed:`n$($out -join "`n")"
    }
    return $out
}

function Get-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    return (& git @GitArgs 2>$null)
}

# Runs a git command for its exit status only; no output is captured.
function Test-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    & git @GitArgs *> $null
    return ($LASTEXITCODE -eq 0)
}

Set-Location $RepoPath

# ---------------------------------------------------------------- preflight
Write-Step 'Batched upload'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git not found on PATH' }

$currentBranch = (Get-Git branch --show-current | Select-Object -First 1).Trim()
$remoteUrl = (Get-Git remote get-url $Remote | Select-Object -First 1).Trim()

Write-Kv 'Repository' $RepoPath
Write-Kv 'Remote' "$Remote  $remoteUrl"
Write-Kv 'Branch' $currentBranch
Write-Kv 'Batch target' "$BatchMB MB"
Write-Kv 'Max retries' $MaxRetries

if ($currentBranch -ne $Branch) {
    Write-Host ''
    Write-Host "  Refusing to run: expected branch '$Branch', found '$currentBranch'." -ForegroundColor Red
    Write-Host "  Switch branches yourself, then re-run." -ForegroundColor Yellow
    exit 1
}

# ---------------------------------------------------------------- remote state
Write-Step 'Reachability and remote state'

try {
    Invoke-Git ls-remote --heads $Remote $Branch | Out-Null
    Write-Kv 'Remote reachable' 'yes' 'Green'
} catch {
    Write-Host '  Cannot reach the remote. Check the network or the proxy.' -ForegroundColor Red
    Write-Host "  current http.proxy = $((Get-Git config --get http.proxy) -join '')" -ForegroundColor Yellow
    exit 1
}

try {
    Invoke-Git fetch $Remote $Branch --quiet
} catch {
    Write-Host '  git fetch failed; continuing with the last known remote state.' -ForegroundColor Yellow
}

$remoteHead = (Get-Git rev-parse "$Remote/$Branch" | Select-Object -First 1).Trim()
$localHead = (Get-Git rev-parse HEAD | Select-Object -First 1).Trim()
Write-Kv 'origin/master' $remoteHead.Substring(0, 10)
Write-Kv 'local HEAD' $localHead.Substring(0, 10)

# ---------------------------------------------------------------- git http diagnosis
Write-Step 'git HTTP settings'

$httpKeys = @{
    'http.postBuffer'    = 'Chunked upload threshold. Very large values buffer in RAM.'
    'http.version'       = 'HTTP/1.1 is steadier than HTTP/2 through proxies.'
    'http.lowSpeedLimit' = '0 disables the stall timeout, so a dead link hangs forever.'
    'http.lowSpeedTime'  = 'Seconds below lowSpeedLimit before git gives up.'
    'http.proxy'         = 'Proxy used for the push.'
}
$needsTuning = $false
foreach ($k in $httpKeys.Keys | Sort-Object) {
    $v = (Get-Git config --get $k | Select-Object -First 1)
    if (-not $v) { $v = '(unset)' }
    $flag = ''
    if ($k -eq 'http.lowSpeedLimit' -and ($v -eq '0' -or $v -eq '(unset)')) { $flag = '  <-- stalls never time out'; $needsTuning = $true }
    Write-Host ('  {0,-20} {1}{2}' -f $k, $v, $flag) -ForegroundColor $(if ($flag) { 'Yellow' } else { 'Gray' })
}
$maxBuffer = (Get-Git config --get http.postBuffer | Select-Object -First 1)
if ($maxBuffer -and [int64]$maxBuffer -gt 200MB) {
    Write-Host "  http.postBuffer above 200MB can exhaust memory on a large push." -ForegroundColor Yellow
    $needsTuning = $true
}

# ---------------------------------------------------------------- unpushed work
Write-Step 'Pending work'

$pendingCommits = @(Get-Git rev-list --reverse "$remoteHead..HEAD")
$base = $remoteHead
if (Test-Git rev-parse -q --verify $BaseTag) {
    $recorded = (Get-Git rev-parse $BaseTag | Select-Object -First 1).Trim()
    # Keep using the original base so a resumed run rebuilds the same commits.
    if (Test-Git merge-base --is-ancestor $recorded HEAD) { $base = $recorded }
}

Write-Kv 'Base commit' $base.Substring(0, 10)
Write-Kv 'Commits ahead' $pendingCommits.Count

if ($pendingCommits.Count -gt 0) {
    Write-Host ''
    Write-Host '  commit      files        size   subject' -ForegroundColor DarkGray
    $totalPending = 0L
    foreach ($sha in $pendingCommits) {
        $subject = (Get-Git log -1 --format=%s $sha | Select-Object -First 1)
        $added = @(Get-Git diff-tree -r --no-commit-id --name-only --diff-filter=A $sha)
        $bytes = 0L
        foreach ($f in $added) {
            $p = Join-Path $RepoPath $f
            if (Test-Path -LiteralPath $p) { $bytes += (Get-Item -LiteralPath $p).Length }
        }
        $totalPending += $bytes
        Write-Host ('  {0}  {1,7}  {2,10}   {3}' -f $sha.Substring(0, 7), $added.Count, (Format-Size $bytes), $subject)
    }
    Write-Kv 'Total in commits' (Format-Size $totalPending) 'Yellow'
}

# ---------------------------------------------------------------- big file guard
Write-Step 'GitHub hard limits'

$oversize = @()
$warn = @()
foreach ($f in (Get-Git ls-files)) {
    $p = Join-Path $RepoPath $f
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $len = (Get-Item -LiteralPath $p).Length
    if ($len -gt 100MB) { $oversize += [pscustomobject]@{ Path = $f; Size = $len } }
    elseif ($len -gt 50MB) { $warn += [pscustomobject]@{ Path = $f; Size = $len } }
}
if ($oversize.Count) {
    Write-Host "  $($oversize.Count) file(s) exceed GitHub's 100MB limit and will be rejected:" -ForegroundColor Red
    $oversize | ForEach-Object { Write-Host ('    {0}  {1}' -f (Format-Size $_.Size), $_.Path) -ForegroundColor Red }
    Write-Host '  Move them to Git LFS or drop them before pushing.' -ForegroundColor Yellow
    exit 1
}
Write-Host '  No file exceeds 100MB.' -ForegroundColor Green
if ($warn.Count) {
    Write-Host "  $($warn.Count) file(s) between 50MB and 100MB (slow but allowed)." -ForegroundColor Yellow
}

$workingChanges = @(Get-Git -c status.renames=false status --porcelain)
if ($workingChanges.Count) {
    Write-Kv 'Uncommitted changes' $workingChanges.Count 'Yellow'
    $workingChanges | Select-Object -First 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}

if ($Status) {
    Write-Host ''
    Write-Host '  Status only, nothing was changed.' -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------- split history
# Everything that differs from the base: committed work plus untracked files.
# Computed without touching the index so that -DryRun stays read-only.
function Get-ChangedPaths {
    $paths = @()
    foreach ($line in (Get-Git diff --name-only $base HEAD)) {
        if ($line) { $paths += $line }
    }
    foreach ($line in (Get-Git -c status.renames=false status --porcelain)) {
        if ($line.StartsWith('??')) { $paths += $line.Substring(3).Trim('"') }
    }
    return @($paths | Sort-Object -Unique)
}

function Get-PlannedBatches {
    param([string[]]$Paths, [int]$TargetMB)

    $sized = foreach ($rel in $Paths) {
        $full = Join-Path $RepoPath $rel
        $bytes = 0L
        if (Test-Path -LiteralPath $full) { $bytes = (Get-Item -LiteralPath $full).Length }
        [pscustomobject]@{ Path = $rel; Bytes = $bytes }
    }
    $sized = @($sized | Sort-Object Path)

    $batches = @()
    $current = @()
    $currentBytes = 0L
    $limit = [int64]$TargetMB * $MB
    foreach ($item in $sized) {
        # A single oversized file still goes out alone rather than breaking the run.
        if ($current.Count -gt 0 -and ($currentBytes + $item.Bytes) -gt $limit) {
            $batches += , $current
            $current = @()
            $currentBytes = 0L
        }
        $current += $item
        $currentBytes += $item.Bytes
    }
    if ($current.Count -gt 0) { $batches += , $current }
    return $batches
}

function Test-AlreadySplit {
    $ahead = @(Get-Git rev-list --reverse "$base..HEAD")
    if ($ahead.Count -eq 0) { return $false }
    $subjects = @(Get-Git log --format=%s "$base..HEAD")
    foreach ($s in $subjects) {
        if (-not $s.StartsWith($BatchPrefix)) { return $false }
    }
    return $true
}

$changedPaths = Get-ChangedPaths
$plan = Get-PlannedBatches -Paths $changedPaths -TargetMB $BatchMB
Write-Step 'Batch plan'
Write-Host "  $($plan.Count) batch(es) at up to $BatchMB MB each, $($changedPaths.Count) path(s) total" -ForegroundColor Cyan
if ($plan.Count -eq 0) {
    Write-Host '  Nothing changed against the base. Only the branch ref may need moving.' -ForegroundColor Yellow
}

$i = 0
foreach ($b in $plan) {
    $i++
    $bytes = ($b | Measure-Object Bytes -Sum).Sum
    Write-Host ('  {0,3}/{1,-3} {2,6} files {3,10}' -f $i, $plan.Count, $b.Count, (Format-Size $bytes))
}

if ($DryRun) {
    Write-Host ''
    Write-Host '  Dry run: no config change, no commit, no push.' -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------- http tuning
if (-not $NoTune) {
    Write-Step 'Adjusting git HTTP settings'
    $settings = @{
        'http.postBuffer'    = '157286400'   # 150MB, keeps chunked upload without huge RAM buffering
        'http.version'       = 'HTTP/1.1'
        'http.lowSpeedLimit' = '1000'        # 1 KB/s
        'http.lowSpeedTime'  = '60'          # give up after 60s below that, so retries can happen
    }
    foreach ($k in $settings.Keys) {
        Invoke-Git config --local $k $settings[$k] | Out-Null
        Write-Kv $k $settings[$k] 'Green'
    }
    Write-Host '  A stalled transfer now fails fast instead of hanging forever.' -ForegroundColor Green
}

Write-Step 'Building batched commits'

if (Test-AlreadySplit) {
    Write-Host '  History is already split; reusing it.' -ForegroundColor Green
} else {
    # Safety net: the rewrite below replaces the local commits, so keep a
    # pointer to the original tip until the push has succeeded.
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupRef = "backup/pre-batch-$stamp"
    Invoke-Git branch $backupRef $localHead | Out-Null
    Write-Kv 'Backup branch' $backupRef 'Green'
    Write-Host "  Restore with: git reset --hard $backupRef" -ForegroundColor DarkGray

    if (-not (Test-Git rev-parse -q --verify $BaseTag)) {
        Invoke-Git tag -f push-batched-base $base | Out-Null
        Write-Kv 'Recorded base' $base.Substring(0, 10) 'Green'
    }

    # Pin the date so a resumed run reproduces identical commit ids.
    $pinnedDate = (Get-Git log -1 --format=%aI $base | Select-Object -First 1).Trim()
    $env:GIT_AUTHOR_DATE = $pinnedDate
    $env:GIT_COMMITTER_DATE = $pinnedDate

    Invoke-Git reset --soft $base | Out-Null
    Invoke-Git reset | Out-Null   # index back to base, working tree untouched

    $n = $plan.Count
    $i = 0
    foreach ($batch in $plan) {
        $i++
        $paths = @($batch | ForEach-Object { $_.Path })
        # Chunk the add so the command line stays a sane length.
        for ($c = 0; $c -lt $paths.Count; $c += 200) {
            $slice = $paths[$c..([Math]::Min($c + 199, $paths.Count - 1))]
            Invoke-Git add -A -- @slice | Out-Null
        }
        $bytes = ($batch | Measure-Object Bytes -Sum).Sum
        $msg = '{0} {1}/{2} ({3} files, {4})' -f $BatchPrefix, $i, $n, $batch.Count, (Format-Size $bytes)
        Invoke-Git commit -q -m $msg | Out-Null
        Write-Host ('  committed {0}/{1}  {2}' -f $i, $n, (Format-Size $bytes)) -ForegroundColor Green
    }

    Remove-Item Env:\GIT_AUTHOR_DATE -ErrorAction SilentlyContinue
    Remove-Item Env:\GIT_COMMITTER_DATE -ErrorAction SilentlyContinue

    # Anything still outstanding (ignored-file edge cases) lands in one last commit.
    $left = @(Get-Git -c status.renames=false status --porcelain)
    if ($left.Count) {
        Invoke-Git add -A | Out-Null
        Invoke-Git commit -q -m "$BatchPrefix extra" | Out-Null
        Write-Host '  committed trailing changes' -ForegroundColor Green
    }
}

# ---------------------------------------------------------------- push loop
if ($NoPush) {
    Write-Step 'Split complete'
    Write-Host '  -NoPush was given, so nothing was uploaded.' -ForegroundColor Green
    Write-Host '  Commit chain is ready; re-run without -NoPush to upload it.' -ForegroundColor Green
    Write-Host "  New tip: $((Get-Git rev-parse HEAD | Select-Object -First 1).Trim().Substring(0,10))" -ForegroundColor Gray
    exit 0
}

Write-Step 'Pushing'

$toPush = @(Get-Git rev-list --reverse "$remoteHead..HEAD")
if ($toPush.Count -eq 0) {
    Write-Host '  Nothing to push.' -ForegroundColor Green
} else {
    Write-Host "  $($toPush.Count) commit(s) to push" -ForegroundColor Cyan
}

$pushed = 0
$failed = $null

foreach ($sha in $toPush) {
    # Resume: skip anything the remote already has.
    if (Test-Git merge-base --is-ancestor $sha "$Remote/$Branch") {
        Write-Host ('  {0}  already on remote, skipping' -f $sha.Substring(0, 7)) -ForegroundColor DarkGray
        continue
    }

    $subject = (Get-Git log -1 --format=%s $sha | Select-Object -First 1)
    $bytes = 0L
    $parent = (Get-Git rev-parse "$sha^" | Select-Object -First 1).Trim()
    foreach ($f in (Get-Git diff-tree -r --no-commit-id --name-only --diff-filter=A $sha)) {
        $p = Join-Path $RepoPath $f
        if (Test-Path -LiteralPath $p) { $bytes += (Get-Item -LiteralPath $p).Length }
    }

    Write-Host ''
    Write-Host ('  -> {0}  {1}  {2}' -f $sha.Substring(0, 7), (Format-Size $bytes), $subject) -ForegroundColor Cyan

    $ok = $false
    for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
        if ($attempt -gt 1) {
            $wait = [Math]::Min(60, 5 * $attempt)
            Write-Host "     attempt $attempt/$MaxRetries after ${wait}s..." -ForegroundColor Yellow
            Start-Sleep -Seconds $wait
        }

        & git push $Remote "${sha}:refs/heads/$Branch" 2>&1 | ForEach-Object {
            if ($_ -match 'error|fatal|rejected|timed out|Could not') { Write-Host "     $_" -ForegroundColor DarkYellow }
        }

        if ($LASTEXITCODE -eq 0) { $ok = $true; break }
        Write-Host "     push failed (exit $LASTEXITCODE)" -ForegroundColor Red
    }

    if (-not $ok) {
        $failed = $sha
        break
    }

    Invoke-Git fetch $Remote $Branch --quiet
    $remoteHead = (Get-Git rev-parse "$Remote/$Branch" | Select-Object -First 1).Trim()
    $pushed++
    Write-Host "     ok, remote is now $($remoteHead.Substring(0,7))" -ForegroundColor Green
}

# ---------------------------------------------------------------- finalize
Write-Step 'Result'

if ($failed) {
    Write-Host "  Stopped at $($failed.Substring(0,7)) after $pushed successful batch(es)." -ForegroundColor Red
    Write-Host '  The remote kept everything already accepted. Re-run this script to resume' -ForegroundColor Yellow
    Write-Host '  from here; batches already uploaded are detected and skipped.' -ForegroundColor Yellow
    exit 1
}

Invoke-Git fetch $Remote $Branch --quiet
$remoteHead = (Get-Git rev-parse "$Remote/$Branch" | Select-Object -First 1).Trim()
$localHead = (Get-Git rev-parse HEAD | Select-Object -First 1).Trim()

Write-Kv 'Batches pushed' $pushed 'Green'
Write-Kv 'origin/master' $remoteHead.Substring(0, 10)
Write-Kv 'local HEAD' $localHead.Substring(0, 10)

if ($remoteHead -eq $localHead) {
    Write-Host ''
    Write-Host '  Up to date. Everything local is on the remote.' -ForegroundColor Green
    exit 0
}

# The remote is behind but not diverged: a plain fast-forward covers it.
if (Test-Git merge-base --is-ancestor "$Remote/$Branch" HEAD) {
    Write-Host ''
    Write-Host '  Remote is behind but fast-forwardable; pushing the tip...' -ForegroundColor Yellow
    Invoke-Git push $Remote "$Branch`:$Branch" | Out-Null
    Invoke-Git fetch $Remote $Branch --quiet
    $remoteHead = (Get-Git rev-parse "$Remote/$Branch" | Select-Object -First 1).Trim()
    if ($remoteHead -eq $localHead) {
        Write-Host '  Up to date.' -ForegroundColor Green
        exit 0
    }
}

if ($Force) {
    Write-Host ''
    Write-Host "  Force-with-lease $Branch -> $($localHead.Substring(0,7))" -ForegroundColor Yellow
    Invoke-Git push --force-with-lease $Remote "$Branch`:$Branch" | Out-Null
    Write-Host '  Overwritten.' -ForegroundColor Green
    exit 0
}

Write-Host ''
Write-Host "  origin/$Branch is at $($remoteHead.Substring(0,7)) but tip is $($localHead.Substring(0,7))." -ForegroundColor Red
Write-Host '  The remote diverged. Re-run with -Force to overwrite it.' -ForegroundColor Yellow
exit 1
