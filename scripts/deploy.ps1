<#
.SYNOPSIS
    Deploys geniesolos.com to S3 + CloudFront from this machine.

.DESCRIPTION
    A backup path for when GitHub Actions is unavailable. It performs exactly
    the same steps as .github/workflows/deploy.yml, in the same order, with the
    same cache headers, so whichever route runs the bucket ends up identical.

    This does NOT replace the workflow. Pushing to main still deploys normally.
    Use this only when Actions is down or you need to ship without a commit.

.PARAMETER DryRun
    Show what would change without uploading, deleting, or invalidating.

.PARAMETER SkipInvalidation
    Upload but do not invalidate CloudFront. Rarely wanted: index.html is
    served must-revalidate, but css/js/assets are cached for 7 days at the
    edge and will serve stale until an invalidation clears them.

.PARAMETER Force
    Skip the confirmation prompt.

.EXAMPLE
    .\scripts\deploy.ps1 -DryRun
    .\scripts\deploy.ps1
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$SkipInvalidation,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$Bucket         = 'geniesolos-com-site'
$DistributionId = 'E13HIX0DOKUMO1'
$Region         = 'us-east-1'
$SiteUrl        = 'https://geniesolos.com/'
$HtmlFiles      = @('index.html', '404.html', 'terms.html', 'store.html')

# $Region is passed explicitly to every AWS call below. Without it the CLI
# falls back to whatever region the active profile happens to be configured
# for, so this script would silently target the wrong place on another
# machine. CloudFront is global and always served from us-east-1, so the flag
# is a no-op there, but passing it everywhere keeps the calls consistent.

# Default-DENY. Everything is excluded, then site paths are added back.
#
# The previous blacklist approach published anything new in the repo unless
# someone remembered to add an exclude for it - a .vscode/mcp.json appeared
# and would have gone straight onto the public site. A whitelist means a
# stray .env, note, or config is never published by accident.
#
# Order matters to `aws s3 sync`: filters apply in sequence, so --exclude "*"
# must come first. MUST stay identical to .github/workflows/deploy.yml -
# both run --delete, so divergence makes each undo the other. The drift
# check below compares the two sequences on every run.
$SyncFilters = @(
    '--exclude', '*',
    '--include', 'css/*',
    '--include', 'js/*',
    '--include', 'assets/*',
    '--include', 'robots.txt',
    '--include', 'sitemap.xml'
)

$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot
try {
    function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
    function Ok($msg)       { Write-Host "    $msg" -ForegroundColor Green }
    function Warn($msg)     { Write-Host "    $msg" -ForegroundColor Yellow }

    Write-Host "Deploying $RepoRoot -> s3://$Bucket" -ForegroundColor White
    if ($DryRun) { Write-Host "DRY RUN - nothing will be changed" -ForegroundColor Magenta }

    # ---------------------------------------------------------------- 1
    Step 1 'Preflight'

    if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
        throw "AWS CLI not found on PATH. Install it or run the GitHub Actions workflow instead."
    }

    $ident = aws sts get-caller-identity --region $Region --output json 2>&1 | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "AWS credentials are not working. Run 'aws configure'." }
    Ok "account $($ident.Account) as $(($ident.Arn -split '/')[-1])"

    aws s3api head-bucket --bucket $Bucket --region $Region 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot reach bucket '$Bucket' in $Region." }
    $distStatus = aws cloudfront get-distribution --id $DistributionId --region $Region --query 'Distribution.Status' --output text 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Cannot reach CloudFront distribution '$DistributionId'." }
    Ok "bucket reachable in $Region, distribution $DistributionId is $distStatus"

    foreach ($f in $HtmlFiles) {
        if (-not (Test-Path (Join-Path $RepoRoot $f))) { throw "Missing expected file: $f" }
    }

    # ---------------------------------------------------------------- 2
    Step 2 'Checking for exclude-list drift against the workflow'

    $wf = Join-Path $RepoRoot '.github\workflows\deploy.yml'
    if (Test-Path $wf) {
        # Compared as an ordered sequence, not a set: aws s3 sync applies
        # filters in order, so the same patterns in a different order can
        # produce a different result.
        $wfFilters = [regex]::Matches((Get-Content $wf -Raw), '--(exclude|include)\s+"([^"]+)"') |
                     ForEach-Object { "--$($_.Groups[1].Value)"; $_.Groups[2].Value }
        if (($wfFilters -join ' ') -ne ($SyncFilters -join ' ')) {
            Warn 'Sync filters DIFFER from .github/workflows/deploy.yml:'
            Warn "  workflow : $($wfFilters -join ' ')"
            Warn "  script   : $($SyncFilters -join ' ')"
            Warn 'Both use --delete, so they will fight and undo each other. Reconcile them.'
        } else { Ok "sync filters match ($(($SyncFilters.Count)/2) rules, in order)" }
    } else { Warn 'workflow not found, skipping drift check' }

    # ---------------------------------------------------------------- 3
    Step 3 'Working tree state'

    # The workflow deploys the committed tree; this deploys whatever is on disk.
    # That difference is the whole point during an outage, but it should be a
    # deliberate choice rather than a surprise.
    $dirty  = git status --porcelain 2>$null
    $branch = git rev-parse --abbrev-ref HEAD 2>$null
    $head   = git rev-parse --short HEAD 2>$null
    Ok "branch $branch at $head"
    if ($dirty) {
        Warn "Working tree has uncommitted changes - deploying files as they exist on disk:"
        ($dirty -split "`n" | Select-Object -First 10) | ForEach-Object { Warn "  $_" }
        Warn "Commit and push afterwards, or the next workflow run will revert the site."
    } else { Ok "working tree clean" }

    if (-not $DryRun -and -not $Force) {
        $answer = Read-Host "`nProceed with deploy to $SiteUrl ? (y/N)"
        if ($answer -notmatch '^(y|yes)$') { Write-Host "Aborted." -ForegroundColor Yellow; return }
    }

    # ---------------------------------------------------------------- 4
    Step 4 'Syncing static assets (7-day cache)'

    # max-age is for browsers, s-maxage for CloudFront. A 7-day browser cache
    # meant a JS fix could not reach a returning visitor for a week, because an
    # invalidation clears the edge but never the browser. Browsers now
    # revalidate every 5 minutes while the edge still caches for a week.
    $syncArgs = @('s3', 'sync', '.', "s3://$Bucket", '--delete', '--region', $Region) + $SyncFilters +
                @('--cache-control', 'public, max-age=300, s-maxage=604800')
    if ($DryRun) { $syncArgs += '--dryrun' }
    aws @syncArgs
    if ($LASTEXITCODE -ne 0) { throw "s3 sync failed" }
    Ok 'assets synced'

    # ---------------------------------------------------------------- 5
    Step 5 'Uploading HTML (always revalidated)'

    # Last, and never long-cached, so a browser cannot pair a fresh stylesheet
    # with a stale document.
    foreach ($f in $HtmlFiles) {
        $cpArgs = @('s3', 'cp', $f, "s3://$Bucket/$f", '--region', $Region,
                    '--cache-control', 'public, max-age=0, must-revalidate',
                    '--content-type', 'text/html; charset=utf-8')
        if ($DryRun) { $cpArgs += '--dryrun' }
        aws @cpArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "upload failed: $f" }
        Ok "uploaded $f"
    }

    # Clean-URL copy: S3 has no rewrite rules, the object key IS the URL, so
    # /terms only works if an object named "terms" exists. Keep identical to
    # the extensionless upload in .github/workflows/deploy.yml.
    $cpArgs = @('s3', 'cp', 'terms.html', "s3://$Bucket/terms", '--region', $Region,
                '--cache-control', 'public, max-age=0, must-revalidate',
                '--content-type', 'text/html; charset=utf-8')
    if ($DryRun) { $cpArgs += '--dryrun' }
    aws @cpArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "upload failed: terms (clean URL)" }
    Ok "uploaded terms.html as /terms"

    # Clean-URL copy for the store, same reasoning as terms above. Keep
    # identical to the extensionless upload in .github/workflows/deploy.yml.
    $cpArgs = @('s3', 'cp', 'store.html', "s3://$Bucket/store", '--region', $Region,
                '--cache-control', 'public, max-age=0, must-revalidate',
                '--content-type', 'text/html; charset=utf-8')
    if ($DryRun) { $cpArgs += '--dryrun' }
    aws @cpArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "upload failed: store (clean URL)" }
    Ok "uploaded store.html as /store"

    # ---------------------------------------------------------------- 6
    if ($SkipInvalidation) {
        Step 6 'Skipping CloudFront invalidation (requested)'
        Warn 'css/js/assets may serve stale from the edge for up to 7 days.'
    } elseif ($DryRun) {
        Step 6 'Would invalidate CloudFront /*'
    } else {
        Step 6 'Invalidating CloudFront'
        $invId = aws cloudfront create-invalidation --distribution-id $DistributionId `
                   --region $Region --paths '/*' --query 'Invalidation.Id' --output text
        if ($LASTEXITCODE -ne 0) { throw "could not create invalidation" }
        Ok "invalidation $invId created, waiting..."
        aws cloudfront wait invalidation-completed --distribution-id $DistributionId `
            --region $Region --id $invId
        if ($LASTEXITCODE -ne 0) { Warn "waiter returned non-zero; the invalidation may still be in progress" }
        else { Ok 'invalidation complete' }
    }

    # ---------------------------------------------------------------- 7
    Step 7 'Verifying the live site'

    if ($DryRun) { Ok 'skipped for dry run' }
    else {
        $resp = Invoke-WebRequest -Uri $SiteUrl -UseBasicParsing -TimeoutSec 30
        if ($resp.StatusCode -ne 200) { throw "$SiteUrl returned $($resp.StatusCode)" }
        Ok "$SiteUrl -> HTTP 200 ($($resp.RawContentLength) bytes)"

        # Prove the bytes served are the bytes we just uploaded, rather than
        # trusting that a 200 means the deploy landed.
        $localHash = (Get-FileHash (Join-Path $RepoRoot 'index.html') -Algorithm SHA256).Hash
        $tmp = Join-Path ([IO.Path]::GetTempPath()) "geniesolos-verify-$PID.html"
        Invoke-WebRequest -Uri $SiteUrl -OutFile $tmp -TimeoutSec 30
        $liveHash = (Get-FileHash $tmp -Algorithm SHA256).Hash
        Remove-Item $tmp -ErrorAction SilentlyContinue
        if ($localHash -eq $liveHash) { Ok 'live index.html matches local byte for byte' }
        else { Warn 'live index.html differs from local - the edge may still be settling' }
    }

    Write-Host "`nDone." -ForegroundColor Green
}
finally { Pop-Location }
