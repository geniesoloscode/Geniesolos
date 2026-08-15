<#
.SYNOPSIS
    Wires the geniesolos-checkout Lambda behind https://geniesolos.com/api/*
    and provisions the order-notification pipeline (SNS topic, webhook
    Lambda, Stripe webhook endpoint).

.DESCRIPTION
    Idempotent setup for the checkout backend: an IAM role, the Lambda
    function and its environment variables, an AWS_IAM function URL that
    CloudFront is allowed to invoke, an Origin Access Control for it, and a
    CloudFront distribution patch that adds a checkout-lambda origin plus an
    /api/* cache behavior. Every step is get-then-create, so running this a
    second time after a successful run finds everything already in place and
    changes nothing.

    Steps 8-13 provision order notifications: an SNS topic
    (geniesolos-orders) with an email subscription to the owner, an inline
    sns:Publish policy on the checkout role, the geniesolos-orders-webhook
    Lambda from api/webhook/index.mjs behind a PUBLIC (auth-type NONE)
    function URL - Stripe cannot send the x-amz-content-sha256 header the
    CloudFront OAC path demands, so that function's front door is the Stripe
    signature check instead - and a mode-aware Stripe webhook endpoint for
    checkout.session.completed. The whsec_ secret Stripe returns exactly
    once, at endpoint creation, is written straight into the Lambda's env
    and never printed beyond the "whsec_" prefix.

    Reads the Stripe secret key from scripts\.secrets\stripe-<Mode>.key and
    the price catalog from scripts\price-map.<Mode>.json (both produced by
    scripts\setup-stripe.ps1) and pushes them into the Lambda's environment
    exactly the way api/checkout/index.mjs reads them: STRIPE_SECRET_KEY,
    PRICE_MAP (compact JSON), ALLOWED_ORIGIN. The secret key is never printed
    in full - only "sk_xxxx_...xxxx", the same masking scripts\setup-stripe.ps1
    uses - and a real (non-DryRun) run refuses to start without both files.

    The CloudFront distribution edit is the one step that is not silently
    idempotent-and-done: it prints a diff of the config change and requires
    an explicit "y" before calling update-distribution, because a bad edit to
    a shared, live distribution is expensive to unwind. -DryRun always skips
    the apply, even after the diff, and every other mutating call in this
    script (create-role, create-function, update-function-code,
    update-function-configuration, create-function-url-config, add-permission,
    create-origin-access-control, update-distribution, iam put-role-policy,
    sns create-topic, sns subscribe, and the Stripe POST
    /v1/webhook_endpoints) is gated the same way.

.PARAMETER Mode
    'test' or 'live'. Selects which key file and price-map file to read.
    Defaults to 'test' so a bare invocation can never touch live data.

.PARAMETER DryRun
    Read-only: reports what each step WOULD do without making any AWS write
    call. Reads (get-role, get-function, list-origin-access-controls,
    get-distribution-config, sts get-caller-identity, ...) still run, so this
    also doubles as a drift check against what already exists.

.EXAMPLE
    .\scripts\setup-aws.ps1 -DryRun
    .\scripts\setup-aws.ps1
    .\scripts\setup-aws.ps1 -Mode live
#>
[CmdletBinding()]
param(
    [ValidateSet('test', 'live')]
    [string]$Mode = 'test',
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# $Region is passed explicitly to every aws call below, IAM/CloudFront being
# global services included - see scripts\deploy.ps1's comment on the same
# convention. Without it the CLI falls back to whatever region the active
# profile happens to be configured for.
$Region                = 'us-east-1'
$DistributionId        = 'E13HIX0DOKUMO1'
$FnName                = 'geniesolos-checkout'
$RoleName               = 'geniesolos-checkout-role'
$OacName                = 'geniesolos-checkout-oac'
$AllowedOrigin          = 'https://geniesolos.com'
$CachePolicyId          = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad' # AWS managed: CachingDisabled
$OriginRequestPolicyId  = 'b689b0a8-53d0-40ab-baf2-68738e2966ac' # AWS managed: AllViewerExceptHostHeader
$OrdersTopicName        = 'geniesolos-orders'
$OrdersEmail            = 'geniesolostech@gmail.com'
$WebhookFnName          = 'geniesolos-orders-webhook'
$SnsPolicyName          = 'sns-publish-orders'
$StripeApi              = 'https://api.stripe.com'

$RepoRoot      = Split-Path -Parent $PSScriptRoot
$KeyFile       = Join-Path $RepoRoot "scripts\.secrets\stripe-$Mode.key"
$MapFile       = Join-Path $RepoRoot "scripts\price-map.$Mode.json"
$FnSource      = Join-Path $RepoRoot 'api\checkout\index.mjs'
$WebhookSource = Join-Path $RepoRoot 'api\webhook\index.mjs'

Push-Location $RepoRoot
try {
    function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
    function Ok($msg)       { Write-Host "    $msg" -ForegroundColor Green }
    function Warn($msg)     { Write-Host "    $msg" -ForegroundColor Yellow }
    function Would($msg)    { Write-Host "    WOULD $msg" -ForegroundColor Magenta }

    # Shows at most the mode-identifying prefix (sk_test_/sk_live_, 8 chars)
    # plus the last 4 characters. Called on every path that mentions the key
    # so a mistyped or wrong-mode key never leaks more than that into a
    # terminal, transcript, or log - same helper as scripts\setup-stripe.ps1.
    function Mask-Key([string]$k) {
        if ([string]::IsNullOrEmpty($k) -or $k.Length -le 12) { return '****' }
        return "$($k.Substring(0, 8))...$($k.Substring($k.Length - 4))"
    }

    # Same Stripe plumbing as scripts\setup-stripe.ps1: form-encoded bodies
    # (Stripe's API rejects JSON request bodies) and auto-pagination past the
    # 100-item page cap. $StripeKey only ever lands in the Authorization
    # header - no log line or error path echoes it.
    function Invoke-Stripe {
        param(
            [Parameter(Mandatory)] [ValidateSet('GET', 'POST')] [string]$Method,
            [Parameter(Mandatory)] [string]$Path,
            [hashtable]$Body
        )
        $uri = "$StripeApi$Path"
        $headers = @{ Authorization = "Bearer $StripeKey" }
        if ($Method -eq 'GET') {
            return Invoke-RestMethod -Method Get -Uri $uri -Headers $headers
        }
        return Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $Body -ContentType 'application/x-www-form-urlencoded'
    }

    function Get-StripeList {
        param([Parameter(Mandatory)] [string]$Path)
        $all = New-Object System.Collections.Generic.List[object]
        $startingAfter = $null
        do {
            $p = $Path
            if ($startingAfter) { $p += "&starting_after=$startingAfter" }
            $resp = Invoke-Stripe -Method GET -Path $p
            foreach ($item in $resp.data) { $all.Add($item) }
            $startingAfter = $null
            if ($resp.has_more -and $resp.data.Count -gt 0) {
                $startingAfter = $resp.data[$resp.data.Count - 1].id
            }
        } while ($startingAfter)
        return $all
    }

    # Keeps Origins.Items / CacheBehaviors.Items assignment safe regardless of
    # whether the property already exists - a fresh CacheBehaviors block with
    # Quantity 0 has no Items key at all (see get-distribution-config output),
    # so a plain property assignment would fail on it.
    function Set-ItemsProp($parent, $items) {
        if ($parent.PSObject.Properties.Name -contains 'Items') {
            $parent.Items = $items
        } else {
            $parent | Add-Member -NotePropertyName Items -NotePropertyValue $items -Force
        }
        $parent.Quantity = $items.Count
    }

    Write-Host "GenieSolos AWS checkout wiring - mode: $Mode" -ForegroundColor White
    if ($DryRun) { Write-Host 'DRY RUN - reads only, no AWS writes' -ForegroundColor Magenta }

    # ---------------------------------------------------------------- 1
    Step 1 'Preflight'

    if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
        throw 'AWS CLI not found on PATH.'
    }
    if (-not (Test-Path -LiteralPath $FnSource)) {
        throw "Missing $FnSource - is api/checkout/index.mjs present?"
    }
    if (-not (Test-Path -LiteralPath $WebhookSource)) {
        throw "Missing $WebhookSource - is api/webhook/index.mjs present?"
    }

    $identJson = aws sts get-caller-identity --region $Region --output json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "AWS credentials are not working: $identJson" }
    $ident   = $identJson | ConvertFrom-Json
    $Account = $ident.Account
    Ok "account $Account as $(($ident.Arn -split '/')[-1])"

    # Read here (masked immediately) so the rest of the script treats "have a
    # usable key" as a boolean. A real run cannot proceed without it - the
    # Lambda would deploy broken - but -DryRun degrades instead of failing so
    # it stays usable before scripts\setup-stripe.ps1 has ever been run.
    $StripeKey = $null
    $HaveKey   = Test-Path -LiteralPath $KeyFile
    if ($HaveKey) {
        $StripeKey = (Get-Content -LiteralPath $KeyFile -Raw).Trim()
        $expectedPrefix = "sk_${Mode}_"
        if (-not $StripeKey.StartsWith($expectedPrefix)) {
            throw "scripts\.secrets\stripe-$Mode.key does not look like a $Mode key (expected prefix '$expectedPrefix'). Found: $(Mask-Key $StripeKey)"
        }
        Ok "Stripe $Mode key loaded: $(Mask-Key $StripeKey)"
    } elseif ($DryRun) {
        Warn "scripts\.secrets\stripe-$Mode.key not found; env would be set once it exists"
    } else {
        throw "Missing scripts\.secrets\stripe-$Mode.key - create it (see scripts\.secrets\README.txt) before a real run."
    }

    $HavePriceMap    = Test-Path -LiteralPath $MapFile
    $PriceMapCompact = $null
    if ($HavePriceMap) {
        $PriceMapCompact = (Get-Content -LiteralPath $MapFile -Raw | ConvertFrom-Json) | ConvertTo-Json -Depth 5 -Compress
        Ok "price map loaded: scripts\price-map.$Mode.json ($($PriceMapCompact.Length) chars compact)"
    } elseif ($DryRun) {
        Warn "scripts\price-map.$Mode.json not found; env would be set once it exists (run scripts\setup-stripe.ps1 first)"
    } else {
        throw "Missing scripts\price-map.$Mode.json - run scripts\setup-stripe.ps1 -Mode $Mode first."
    }

    # ---------------------------------------------------------------- 2
    Step 2 "IAM role $RoleName"

    $roleRaw    = aws iam get-role --role-name $RoleName --region $Region --output json 2>&1
    $roleExit   = $LASTEXITCODE
    $roleJson   = $roleRaw -join "`n" # 2>&1 yields a mixed array (strings + ErrorRecord); -match/-notmatch on
                                       # an array filters elements instead of returning a bool, so every text
                                       # check below runs against a single joined string, not the raw array.
    $roleExists = ($roleExit -eq 0)

    if ($roleExists) {
        $RoleArn = ($roleJson | ConvertFrom-Json).Role.Arn
        Ok "role exists: $RoleArn"
    } elseif ($roleJson -notmatch 'NoSuchEntity') {
        throw "get-role failed: $roleJson"
    } elseif ($DryRun) {
        Would "create-role $RoleName (trust: lambda.amazonaws.com) and attach AWSLambdaBasicExecutionRole"
        $RoleArn = "arn:aws:iam::${Account}:role/$RoleName" # not yet real; only used to describe later dry-run steps
    } else {
        $trustPolicy = @{
            Version   = '2012-10-17'
            Statement = @(
                @{
                    Effect    = 'Allow'
                    Principal = @{ Service = 'lambda.amazonaws.com' }
                    Action    = 'sts:AssumeRole'
                }
            )
        } | ConvertTo-Json -Depth 5
        $trustFile = Join-Path $env:TEMP "geniesolos-checkout-trust-$PID.json"
        Set-Content -LiteralPath $trustFile -Value $trustPolicy -Encoding utf8

        $created = aws iam create-role --role-name $RoleName `
            --assume-role-policy-document "file://$trustFile" --region $Region --output json 2>&1
        Remove-Item $trustFile -ErrorAction SilentlyContinue
        if ($LASTEXITCODE -ne 0) { throw "create-role failed: $created" }
        $RoleArn = ($created | ConvertFrom-Json).Role.Arn
        Ok "created role: $RoleArn"

        aws iam attach-role-policy --role-name $RoleName `
            --policy-arn 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' `
            --region $Region 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'attach-role-policy failed' }
        Ok 'attached AWSLambdaBasicExecutionRole'

        # IAM is eventually consistent: a role can 404 on assume for a few
        # seconds after create-role returns 200. create-function below also
        # retries on that specific error, but a short wait avoids burning
        # those retries on the common case.
        Start-Sleep -Seconds 8
    }

    # ---------------------------------------------------------------- 3
    Step 3 "Lambda function $FnName"

    $fnRaw    = aws lambda get-function --function-name $FnName --region $Region --output json 2>&1
    $fnExit   = $LASTEXITCODE
    $fnJson   = $fnRaw -join "`n"
    $fnExists = ($fnExit -eq 0)
    if (-not $fnExists -and $fnJson -notmatch 'ResourceNotFoundException') {
        throw "get-function failed: $fnJson"
    }

    $zipPath = Join-Path $env:TEMP "geniesolos-checkout-$PID.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    # Zipped from its own file path, not the api\checkout directory, so
    # index.mjs lands at the ARCHIVE ROOT. Lambda resolves the handler
    # "index.handler" against the root of the zip, not a subpath - zipping
    # the directory instead would put it at api/checkout/index.mjs and break
    # handler resolution.
    Compress-Archive -Path $FnSource -DestinationPath $zipPath -Force

    if ($fnExists) {
        Ok "function exists: $(($fnJson | ConvertFrom-Json).Configuration.FunctionArn)"
        if ($DryRun) {
            Would "update-function-code from $FnSource"
        } else {
            $upd = aws lambda update-function-code --function-name $FnName `
                --zip-file "fileb://$zipPath" --region $Region --output json 2>&1
            if ($LASTEXITCODE -ne 0) { throw "update-function-code failed: $upd" }
            aws lambda wait function-updated --function-name $FnName --region $Region
            Ok 'code updated'
        }
    } elseif ($DryRun) {
        Would "create-function $FnName (nodejs22.x, index.handler, timeout 15, memory 128, role $RoleArn)"
    } else {
        $create = $null
        # Tolerate the role not being assumable yet immediately after
        # create-role (eventual consistency) rather than failing the whole
        # run over a timing race.
        $createExit = 1
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            $createRaw  = aws lambda create-function --function-name $FnName `
                --runtime nodejs22.x --role $RoleArn --handler index.handler `
                --timeout 15 --memory-size 128 --zip-file "fileb://$zipPath" `
                --region $Region --output json 2>&1
            $createExit = $LASTEXITCODE
            $create     = $createRaw -join "`n"
            if ($createExit -eq 0) { break }
            if ($create -match 'InvalidParameterValueException' -and $create -match 'cannot be assumed') {
                Warn "role not yet assumable, retrying ($attempt/5)..."
                Start-Sleep -Seconds 6
                continue
            }
            throw "create-function failed: $create"
        }
        if ($createExit -ne 0) { throw "create-function failed after retries: $create" }
        aws lambda wait function-active --function-name $FnName --region $Region
        Ok "created: $(($create | ConvertFrom-Json).FunctionArn)"
    }

    Remove-Item $zipPath -ErrorAction SilentlyContinue

    if ($DryRun) {
        if ($HaveKey -and $HavePriceMap) {
            Would "update-function-configuration env: STRIPE_SECRET_KEY=$(Mask-Key $StripeKey), PRICE_MAP=<$($PriceMapCompact.Length) chars>, ALLOWED_ORIGIN=$AllowedOrigin"
        } else {
            Warn "price map or key missing; env would be set once both scripts\.secrets\stripe-$Mode.key and scripts\price-map.$Mode.json exist"
        }
    } else {
        # STRIPE_SECRET_KEY and PRICE_MAP are written to a temp JSON file and
        # passed via file:// rather than inline CLI args, so PRICE_MAP's own
        # embedded quotes/braces never have to survive shell escaping.
        $envObj = [ordered]@{
            Variables = [ordered]@{
                STRIPE_SECRET_KEY = $StripeKey
                PRICE_MAP         = $PriceMapCompact
                ALLOWED_ORIGIN    = $AllowedOrigin
            }
        }
        $envFile = Join-Path $env:TEMP "geniesolos-checkout-env-$PID.json"
        $envObj | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $envFile -Encoding utf8
        $cfgUpd = aws lambda update-function-configuration --function-name $FnName `
            --environment "file://$envFile" --region $Region --output json 2>&1
        Remove-Item $envFile -ErrorAction SilentlyContinue
        if ($LASTEXITCODE -ne 0) { throw "update-function-configuration failed: $cfgUpd" }
        aws lambda wait function-updated --function-name $FnName --region $Region
        Ok "env set: STRIPE_SECRET_KEY=$(Mask-Key $StripeKey), PRICE_MAP=<$($PriceMapCompact.Length) chars>, ALLOWED_ORIGIN=$AllowedOrigin"
    }

    # ---------------------------------------------------------------- 4
    Step 4 'Function URL (AWS_IAM) + CloudFront invoke permission'

    $urlRaw    = aws lambda get-function-url-config --function-name $FnName --region $Region --output json 2>&1
    $urlExit   = $LASTEXITCODE
    $urlJson   = $urlRaw -join "`n"
    $urlExists = ($urlExit -eq 0)
    if (-not $urlExists -and $urlJson -notmatch 'ResourceNotFoundException') {
        throw "get-function-url-config failed: $urlJson"
    }

    if ($urlExists) {
        $FunctionUrl = ($urlJson | ConvertFrom-Json).FunctionUrl
        Ok "function URL exists: $FunctionUrl"
    } elseif ($DryRun) {
        Would 'create-function-url-config --auth-type AWS_IAM'
        $FunctionUrl = $null
    } else {
        $createdUrl = aws lambda create-function-url-config --function-name $FnName `
            --auth-type AWS_IAM --region $Region --output json 2>&1
        if ($LASTEXITCODE -ne 0) { throw "create-function-url-config failed: $createdUrl" }
        $FunctionUrl = ($createdUrl | ConvertFrom-Json).FunctionUrl
        Ok "function URL created: $FunctionUrl"
    }

    # TWO statements, both required. Function URLs created after Oct 2025
    # authorize lambda:InvokeFunctionUrl at the front door AND
    # lambda:InvokeFunction at invocation; granting only the first yields
    # AccessDeniedException on every CloudFront request (observed, and cost
    # a long debugging session on 2026-08-15). No --function-url-auth-type
    # on either: the extra condition is unnecessary against the canonical
    # policy and was in the blast radius during that debugging.
    $SourceArn = "arn:aws:cloudfront::${Account}:distribution/$DistributionId"
    $PermStatements = @(
        @{ Sid = 'cloudfront-invoke';    Action = 'lambda:InvokeFunctionUrl' },
        @{ Sid = 'cloudfront-invoke-fn'; Action = 'lambda:InvokeFunction' }
    )
    foreach ($stmt in $PermStatements) {
        if ($DryRun) {
            Would "add-permission $($stmt.Sid) ($($stmt.Action), principal cloudfront.amazonaws.com, source-arn $SourceArn)"
            continue
        }
        $permRaw  = aws lambda add-permission --function-name $FnName --statement-id $stmt.Sid `
            --action $stmt.Action --principal cloudfront.amazonaws.com `
            --source-arn $SourceArn `
            --region $Region --output json 2>&1
        $permExit = $LASTEXITCODE
        $perm     = $permRaw -join "`n"
        if ($permExit -eq 0) {
            Ok "permission $($stmt.Sid) added"
        } elseif ($perm -match 'ResourceConflictException') {
            Ok "permission $($stmt.Sid) already present"
        } else {
            throw "add-permission failed: $perm"
        }
    }

    # ---------------------------------------------------------------- 5
    Step 5 "Origin Access Control $OacName"

    $oacList = aws cloudfront list-origin-access-controls --region $Region --output json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "list-origin-access-controls failed: $oacList" }
    $existingOac = ($oacList | ConvertFrom-Json).OriginAccessControlList.Items |
        Where-Object { $_.Name -eq $OacName } | Select-Object -First 1

    if ($existingOac) {
        $OacId = $existingOac.Id
        Ok "OAC exists: $OacId"
    } elseif ($DryRun) {
        Would "create-origin-access-control $OacName (SigningProtocol=sigv4, SigningBehavior=always, OriginAccessControlOriginType=lambda)"
        $OacId = $null
    } else {
        $oacCfg  = "Name=$OacName,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=lambda"
        $created = aws cloudfront create-origin-access-control --origin-access-control-config $oacCfg `
            --region $Region --output json 2>&1
        if ($LASTEXITCODE -ne 0) { throw "create-origin-access-control failed: $created" }
        $OacId = ($created | ConvertFrom-Json).OriginAccessControl.Id
        Ok "OAC created: $OacId"
    }

    # ---------------------------------------------------------------- 6
    Step 6 'CloudFront distribution patch (/api/* -> checkout-lambda)'

    $distRaw = aws cloudfront get-distribution-config --id $DistributionId --region $Region --output json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "get-distribution-config failed: $distRaw" }
    $distObj = $distRaw | ConvertFrom-Json
    $ETag    = $distObj.ETag
    $distCfg = $distObj.DistributionConfig

    # Snapshotted as text before any mutation below, so the diff printed
    # later reflects exactly what update-distribution would send.
    $BeforeText = $distCfg | ConvertTo-Json -Depth 20

    $hasOrigin = $false
    if ($distCfg.Origins.Quantity -gt 0) {
        $hasOrigin = [bool]($distCfg.Origins.Items | Where-Object { $_.Id -eq 'checkout-lambda' })
    }
    $hasBehavior = $false
    if ($distCfg.CacheBehaviors.Quantity -gt 0) {
        # Both spellings checked: CloudFront documents the leading slash as
        # optional, but in practice '/api/*' never matched at the edge while
        # 'api/*' does (observed 2026-08-15). New behaviors are created
        # slash-less; an existing slashed one is repaired in place.
        $slashed     = $distCfg.CacheBehaviors.Items | Where-Object { $_.PathPattern -eq '/api/*' }
        $hasBehavior = [bool]($distCfg.CacheBehaviors.Items | Where-Object { $_.PathPattern -in @('api/*', '/api/*') })
    }

    if ($hasOrigin -and $hasBehavior -and $slashed) {
        # Repair path: the behavior exists but with the leading-slash pattern
        # that the edge never matches. Rewrite the pattern in place and push.
        Warn "behavior exists as '/api/*', repairing to 'api/*'"
        $slashed[0].PathPattern = 'api/*'
        $AfterText = $distCfg | ConvertTo-Json -Depth 20
        Write-Host '    --- distribution config diff ---' -ForegroundColor White
        $rdiff = Compare-Object -ReferenceObject ($BeforeText -split "`r?`n") -DifferenceObject ($AfterText -split "`r?`n")
        foreach ($line in $rdiff) {
            $mark = if ($line.SideIndicator -eq '=>') { '+' } else { '-' }
            Write-Host "    $mark $($line.InputObject.Trim())"
        }
        if ($DryRun) {
            Ok 'WOULD update-distribution with the repaired path pattern (skipped: -DryRun)'
        } else {
            $answer = if ($Force) { 'y' } else { Read-Host 'Apply this CloudFront change? (y/N)' }
            if ($answer -notmatch '^(y|yes)$') {
                Warn 'Skipped. Re-run to apply later.'
            } else {
                $cfgFile = Join-Path ([IO.Path]::GetTempPath()) "gs-dist-repair-$PID.json"
                $AfterText | Set-Content $cfgFile -Encoding utf8
                aws cloudfront update-distribution --id $DistributionId --region $Region --if-match $ETag --distribution-config "file://$cfgFile" --output json | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'update-distribution (path repair) failed' }
                Remove-Item $cfgFile -ErrorAction SilentlyContinue
                Ok 'path pattern repaired, waiting for Deployed status...'
                aws cloudfront wait distribution-deployed --id $DistributionId --region $Region
                Ok 'distribution deployed'
            }
        }
    } elseif ($hasOrigin -and $hasBehavior) {
        Ok 'checkout-lambda origin and api/* behavior already present, nothing to change'
    } else {
        # Placeholders only ever surface under -DryRun, when the function URL
        # and/or OAC do not exist yet to read a real value from - they make
        # the printed diff self-explanatory rather than silently wrong.
        $LambdaHost     = if ($FunctionUrl) { ([uri]$FunctionUrl).Host } else { '<function-url-pending>' }
        $EffectiveOacId = if ($OacId) { $OacId } else { '<oac-id-pending>' }

        if (-not $hasOrigin) {
            $newOrigin = @"
{
  "Id": "checkout-lambda",
  "DomainName": "$LambdaHost",
  "OriginPath": "",
  "CustomHeaders": { "Quantity": 0 },
  "CustomOriginConfig": {
    "HTTPPort": 80,
    "HTTPSPort": 443,
    "OriginProtocolPolicy": "https-only",
    "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] },
    "OriginReadTimeout": 30,
    "OriginKeepaliveTimeout": 5
  },
  "ConnectionAttempts": 3,
  "ConnectionTimeout": 10,
  "OriginShield": { "Enabled": false },
  "OriginAccessControlId": "$EffectiveOacId"
}
"@ | ConvertFrom-Json

            $items = @()
            if ($distCfg.Origins.Quantity -gt 0) { $items = @($distCfg.Origins.Items) }
            Set-ItemsProp $distCfg.Origins ($items + $newOrigin)
        }

        if (-not $hasBehavior) {
            $newBehavior = @"
{
  "PathPattern": "api/*",
  "TargetOriginId": "checkout-lambda",
  "TrustedSigners": { "Enabled": false, "Quantity": 0 },
  "TrustedKeyGroups": { "Enabled": false, "Quantity": 0 },
  "ViewerProtocolPolicy": "https-only",
  "AllowedMethods": {
    "Quantity": 7,
    "Items": ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
    "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
  },
  "SmoothStreaming": false,
  "Compress": true,
  "LambdaFunctionAssociations": { "Quantity": 0 },
  "FunctionAssociations": { "Quantity": 0 },
  "FieldLevelEncryptionId": "",
  "CachePolicyId": "$CachePolicyId",
  "OriginRequestPolicyId": "$OriginRequestPolicyId",
  "GrpcConfig": { "Enabled": false }
}
"@ | ConvertFrom-Json

            $behItems = @()
            if ($distCfg.CacheBehaviors.Quantity -gt 0) { $behItems = @($distCfg.CacheBehaviors.Items) }
            Set-ItemsProp $distCfg.CacheBehaviors ($behItems + $newBehavior)
        }

        $AfterText = $distCfg | ConvertTo-Json -Depth 20

        Write-Host ''
        Write-Host '    --- distribution config diff ---' -ForegroundColor White
        $diff = Compare-Object -ReferenceObject ($BeforeText -split "`r?`n") -DifferenceObject ($AfterText -split "`r?`n")
        foreach ($line in $diff) {
            if ($line.SideIndicator -eq '=>') { Write-Host "    + $($line.InputObject)" -ForegroundColor Green }
            else { Write-Host "    - $($line.InputObject)" -ForegroundColor Red }
        }
        Write-Host ''

        if ($DryRun) {
            Would 'update-distribution with the config above (skipped: -DryRun)'
        } elseif (-not $FunctionUrl -or -not $OacId) {
            throw 'Cannot patch the distribution: function URL or OAC id is missing (an earlier step did not complete).'
        } else {
            # -Force mirrors deploy.ps1: the confirm prompt cannot run in a
            # non-interactive shell, and the diff above has been reviewed.
            $answer = if ($Force) { 'y' } else { Read-Host 'Apply this CloudFront change? (y/N)' }
            if ($answer -notmatch '^(y|yes)$') {
                Warn 'Skipped. Re-run to apply later.'
            } else {
                $cfgFile = Join-Path $env:TEMP "geniesolos-checkout-distcfg-$PID.json"
                $distCfg | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $cfgFile -Encoding utf8
                $updResult = aws cloudfront update-distribution --id $DistributionId `
                    --distribution-config "file://$cfgFile" --if-match $ETag --region $Region --output json 2>&1
                Remove-Item $cfgFile -ErrorAction SilentlyContinue
                if ($LASTEXITCODE -ne 0) { throw "update-distribution failed: $updResult" }
                Ok 'distribution updated, waiting for Deployed status (this can take several minutes)...'
                aws cloudfront wait distribution-deployed --id $DistributionId --region $Region
                Ok 'distribution deployed'
            }
        }
    }

    # ---------------------------------------------------------------- 7
    Step 7 'Smoke tests'

    if ($DryRun) {
        Ok 'skipped for dry run'
    } else {
        # SHA-256 of the empty string. CloudFront's OAC signs the request to the
        # function URL with whatever x-amz-content-sha256 the caller sent; it
        # does not compute one, and Lambda function URLs refuse UNSIGNED-PAYLOAD.
        # A POST without this header is a 403 that never reaches the handler, so
        # every curl/Invoke-WebRequest against /api/* must carry it. The store
        # page computes the same value in js/store.js.
        $EmptyBodySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

        # Empty body: JSON.parse('') fails before any Stripe call, so this
        # proves routing + Lambda + validation without spending a Stripe call.
        try {
            $r1 = Invoke-WebRequest -Method Post -Uri 'https://geniesolos.com/api/checkout' -Body '' `
                -Headers @{ 'x-amz-content-sha256' = $EmptyBodySha256 } `
                -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 30
            if ($r1.StatusCode -eq 400) { Ok 'POST /api/checkout (empty body) -> 400 as expected' }
            else { Warn "POST /api/checkout (empty body) -> $($r1.StatusCode), expected 400" }
        } catch {
            Warn "POST /api/checkout failed: $($_.Exception.Message)"
        }

        # Direct, unsigned hit on the raw function URL: AWS_IAM auth should
        # refuse it, proving the origin cannot be reached except through the
        # OAC-signed CloudFront path.
        if ($FunctionUrl) {
            try {
                $r2 = Invoke-WebRequest -Method Post -Uri $FunctionUrl -Body '' `
                    -Headers @{ 'x-amz-content-sha256' = $EmptyBodySha256 } `
                    -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 30
                if ($r2.StatusCode -eq 403) { Ok "POST $FunctionUrl (unsigned) -> 403 as expected" }
                else { Warn "POST $FunctionUrl (unsigned) -> $($r2.StatusCode), expected 403" }
            } catch {
                Warn "direct function URL POST failed: $($_.Exception.Message)"
            }
        } else {
            Warn 'no function URL known, skipping the 403 check'
        }
    }

    # ---------------------------------------------------------------- 8
    Step 8 "SNS topic $OrdersTopicName + email subscription"

    # Topic ARNs are deterministic (arn:aws:sns:<region>:<account>:<name>),
    # so the ARN is computed up front and existence is probed with the
    # read-only get-topic-attributes. create-topic is idempotent by name,
    # but it is still a write, so -DryRun must never reach it.
    $OrdersTopicArn = "arn:aws:sns:${Region}:${Account}:$OrdersTopicName"
    $topicRaw    = aws sns get-topic-attributes --topic-arn $OrdersTopicArn --region $Region --output json 2>&1
    $topicExit   = $LASTEXITCODE
    $topicJson   = $topicRaw -join "`n"
    $topicExists = ($topicExit -eq 0)
    if (-not $topicExists -and $topicJson -notmatch 'NotFound') {
        throw "get-topic-attributes failed: $topicJson"
    }

    if ($topicExists) {
        Ok "topic exists: $OrdersTopicArn"
    } elseif ($DryRun) {
        Would "sns create-topic $OrdersTopicName"
    } else {
        $createdTopic = aws sns create-topic --name $OrdersTopicName --region $Region --output json 2>&1
        if ($LASTEXITCODE -ne 0) { throw "sns create-topic failed: $createdTopic" }
        $OrdersTopicArn = ($createdTopic | ConvertFrom-Json).TopicArn
        $topicExists    = $true
        Ok "topic created: $OrdersTopicArn"
    }

    # Encryption at rest with the AWS-managed SNS key: no monthly key fee,
    # request charges stay inside the KMS free tier at this volume, and the
    # order messages (customer name and email) stop sitting in SNS as
    # plaintext. Idempotent: setting the same value twice is a no-op.
    if ($topicExists) {
        $kmsNow = ($topicJson | ConvertFrom-Json -ErrorAction SilentlyContinue).Attributes.KmsMasterKeyId
        if ($kmsNow -eq 'alias/aws/sns') {
            Ok 'topic encryption at rest already on (alias/aws/sns)'
        } elseif ($DryRun) {
            Would 'sns set-topic-attributes KmsMasterKeyId=alias/aws/sns'
        } else {
            aws sns set-topic-attributes --topic-arn $OrdersTopicArn --attribute-name KmsMasterKeyId --attribute-value alias/aws/sns --region $Region 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'sns set-topic-attributes (KMS) failed' }
            Ok 'topic encryption at rest enabled (alias/aws/sns)'
        }
    } elseif ($DryRun) {
        Would 'sns set-topic-attributes KmsMasterKeyId=alias/aws/sns (after create)'
    }

    $existingSub = $null
    if ($topicExists) {
        $subsRaw = aws sns list-subscriptions-by-topic --topic-arn $OrdersTopicArn --region $Region --output json 2>&1
        if ($LASTEXITCODE -ne 0) { throw "list-subscriptions-by-topic failed: $($subsRaw -join "`n")" }
        $existingSub = ($subsRaw | ConvertFrom-Json).Subscriptions |
            Where-Object { $_.Protocol -eq 'email' -and $_.Endpoint -eq $OrdersEmail } |
            Select-Object -First 1
    }

    if ($existingSub) {
        if ($existingSub.SubscriptionArn -eq 'PendingConfirmation') {
            Warn "email subscription for $OrdersEmail is PendingConfirmation - no order mail flows until the owner clicks the link in the AWS confirmation email"
        } else {
            Ok "email subscription confirmed: $OrdersEmail"
        }
    } elseif ($DryRun) {
        Would "sns subscribe --protocol email --notification-endpoint $OrdersEmail"
    } else {
        $subRes = aws sns subscribe --topic-arn $OrdersTopicArn --protocol email `
            --notification-endpoint $OrdersEmail --region $Region --output json 2>&1
        if ($LASTEXITCODE -ne 0) { throw "sns subscribe failed: $subRes" }
        Ok "subscribed $OrdersEmail"
        Warn 'AWS has sent a confirmation email - the owner must click its link before any order notification is delivered'
    }

    # ---------------------------------------------------------------- 9
    Step 9 "IAM inline policy $SnsPolicyName on $RoleName"

    # put-role-policy is an idempotent overwrite, so no get-then-create dance:
    # writing the same document twice is a no-op by content.
    if ($DryRun) {
        Would "put-role-policy $SnsPolicyName (sns:Publish on $OrdersTopicArn only)"
    } else {
        $snsPolicy = @{
            Version   = '2012-10-17'
            Statement = @(
                @{
                    Effect   = 'Allow'
                    Action   = 'sns:Publish'
                    Resource = $OrdersTopicArn
                }
            )
        } | ConvertTo-Json -Depth 5
        $snsPolicyFile = Join-Path $env:TEMP "geniesolos-orders-snspolicy-$PID.json"
        Set-Content -LiteralPath $snsPolicyFile -Value $snsPolicy -Encoding utf8
        $putPolicy = aws iam put-role-policy --role-name $RoleName --policy-name $SnsPolicyName `
            --policy-document "file://$snsPolicyFile" --region $Region --output json 2>&1
        Remove-Item $snsPolicyFile -ErrorAction SilentlyContinue
        if ($LASTEXITCODE -ne 0) { throw "put-role-policy failed: $putPolicy" }
        Ok "inline policy $SnsPolicyName in place (sns:Publish on the orders topic only)"
    }

    # ---------------------------------------------------------------- 10
    Step 10 "Webhook Lambda $WebhookFnName"

    $whRaw    = aws lambda get-function --function-name $WebhookFnName --region $Region --output json 2>&1
    $whExit   = $LASTEXITCODE
    $whJson   = $whRaw -join "`n"
    $whExists = ($whExit -eq 0)
    if (-not $whExists -and $whJson -notmatch 'ResourceNotFoundException') {
        throw "get-function failed: $whJson"
    }

    $whZip = Join-Path $env:TEMP "geniesolos-orders-webhook-$PID.zip"
    if (Test-Path $whZip) { Remove-Item $whZip -Force }
    # Same archive-ROOT rule as the checkout zip in step 3: zip the file
    # itself, not its directory, so index.mjs lands at the root and the
    # handler "index.handler" resolves.
    Compress-Archive -Path $WebhookSource -DestinationPath $whZip -Force

    if ($whExists) {
        Ok "function exists: $(($whJson | ConvertFrom-Json).Configuration.FunctionArn)"
        if ($DryRun) {
            Would "update-function-code from $WebhookSource"
        } else {
            $whUpd = aws lambda update-function-code --function-name $WebhookFnName `
                --zip-file "fileb://$whZip" --region $Region --output json 2>&1
            if ($LASTEXITCODE -ne 0) { throw "update-function-code failed: $whUpd" }
            aws lambda wait function-updated --function-name $WebhookFnName --region $Region
            Ok 'code updated'
        }
    } elseif ($DryRun) {
        Would "create-function $WebhookFnName (nodejs22.x, index.handler, timeout 10, memory 128, role $RoleArn, placeholder env)"
    } else {
        # Placeholder STRIPE_WEBHOOK_SECRET on purpose: the real whsec_ value
        # only exists after the Stripe endpoint is registered against this
        # function's URL (step 12), which in turn needs the function to
        # exist. Step 12 then sets both env vars for real in one
        # update-function-configuration call. ORDERS_TOPIC_ARN is final
        # already; the placeholder is not a secret and safe to show.
        $whEnvObj = [ordered]@{
            Variables = [ordered]@{
                ORDERS_TOPIC_ARN      = $OrdersTopicArn
                STRIPE_WEBHOOK_SECRET = 'pending-stripe-endpoint-registration'
            }
        }
        $whEnvFile = Join-Path $env:TEMP "geniesolos-orders-webhook-env-$PID.json"
        $whEnvObj | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $whEnvFile -Encoding utf8

        # Same eventual-consistency retry as the checkout create-function:
        # a role created moments ago in step 2 can briefly refuse to be
        # assumed.
        $whCreate     = $null
        $whCreateExit = 1
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            $whCreateRaw  = aws lambda create-function --function-name $WebhookFnName `
                --runtime nodejs22.x --role $RoleArn --handler index.handler `
                --timeout 10 --memory-size 128 --zip-file "fileb://$whZip" `
                --environment "file://$whEnvFile" `
                --region $Region --output json 2>&1
            $whCreateExit = $LASTEXITCODE
            $whCreate     = $whCreateRaw -join "`n"
            if ($whCreateExit -eq 0) { break }
            if ($whCreate -match 'InvalidParameterValueException' -and $whCreate -match 'cannot be assumed') {
                Warn "role not yet assumable, retrying ($attempt/5)..."
                Start-Sleep -Seconds 6
                continue
            }
            Remove-Item $whEnvFile -ErrorAction SilentlyContinue
            throw "create-function failed: $whCreate"
        }
        Remove-Item $whEnvFile -ErrorAction SilentlyContinue
        if ($whCreateExit -ne 0) { throw "create-function failed after retries: $whCreate" }
        aws lambda wait function-active --function-name $WebhookFnName --region $Region
        Ok "created: $(($whCreate | ConvertFrom-Json).FunctionArn) (placeholder env until step 12)"
    }

    Remove-Item $whZip -ErrorAction SilentlyContinue

    # ---------------------------------------------------------------- 11
    Step 11 'Webhook function URL (public, auth NONE) + invoke permissions'

    $whUrlRaw    = aws lambda get-function-url-config --function-name $WebhookFnName --region $Region --output json 2>&1
    $whUrlExit   = $LASTEXITCODE
    $whUrlJson   = $whUrlRaw -join "`n"
    $whUrlExists = ($whUrlExit -eq 0)
    if (-not $whUrlExists -and $whUrlJson -notmatch 'ResourceNotFoundException') {
        throw "get-function-url-config failed: $whUrlJson"
    }

    if ($whUrlExists) {
        $WebhookUrl = ($whUrlJson | ConvertFrom-Json).FunctionUrl
        Ok "webhook URL exists: $WebhookUrl"
    } elseif ($DryRun) {
        Would 'create-function-url-config --auth-type NONE'
        $WebhookUrl = $null
    } else {
        $whCreatedUrl = aws lambda create-function-url-config --function-name $WebhookFnName `
            --auth-type NONE --region $Region --output json 2>&1
        if ($LASTEXITCODE -ne 0) { throw "create-function-url-config failed: $whCreatedUrl" }
        $WebhookUrl = ($whCreatedUrl | ConvertFrom-Json).FunctionUrl
        Ok "webhook URL created: $WebhookUrl"
    }

    # TWO public statements, same hard-won rule as step 4: function URLs
    # created after Oct 2025 authorize lambda:InvokeFunctionUrl at the front
    # door AND lambda:InvokeFunction at invocation, and granting only one of
    # them 403s every Stripe delivery. --function-url-auth-type NONE makes
    # principal '*' legal on the unauthenticated URL, but AWS only accepts
    # that flag on the InvokeFunctionUrl action (observed 2026-08-15:
    # InvalidParameterValueException on InvokeFunction). The InvokeFunction
    # statement is therefore unconditioned; the handler's Stripe-signature
    # gate is what keeps a direct invoke harmless.
    $WebhookPermStatements = @(
        @{ Sid = 'public-url-invoke'; Action = 'lambda:InvokeFunctionUrl'; UrlAuth = $true },
        @{ Sid = 'public-fn-invoke';  Action = 'lambda:InvokeFunction';    UrlAuth = $false }
    )
    foreach ($stmt in $WebhookPermStatements) {
        if ($DryRun) {
            $flagNote = if ($stmt.UrlAuth) { ', function-url-auth-type NONE' } else { '' }
            Would "add-permission $($stmt.Sid) ($($stmt.Action), principal *$flagNote)"
            continue
        }
        $wpArgs = @('lambda', 'add-permission', '--function-name', $WebhookFnName,
                    '--statement-id', $stmt.Sid, '--action', $stmt.Action, '--principal', '*',
                    '--region', $Region, '--output', 'json')
        if ($stmt.UrlAuth) { $wpArgs += @('--function-url-auth-type', 'NONE') }
        $wpRaw  = aws @wpArgs 2>&1
        $wpExit = $LASTEXITCODE
        $wp     = $wpRaw -join "`n"
        if ($wpExit -eq 0) {
            Ok "permission $($stmt.Sid) added"
        } elseif ($wp -match 'ResourceConflictException') {
            Ok "permission $($stmt.Sid) already present"
        } else {
            throw "add-permission failed: $wp"
        }
    }

    # ---------------------------------------------------------------- 12
    Step 12 "Stripe webhook endpoint ($Mode)"

    if (-not $HaveKey) {
        # Only reachable under -DryRun: a real run throws in step 1 without
        # the key file.
        Warn "scripts\.secrets\stripe-$Mode.key not found; endpoint registration would run once it exists"
    } elseif (-not $WebhookUrl) {
        # Only reachable under -DryRun: a real run either found or created
        # the URL in step 11. Without a URL there is nothing to match the
        # endpoint list against, so both mutations are reported as WOULD.
        Would 'POST /v1/webhook_endpoints url=<webhook-url-pending> enabled_events[]=checkout.session.completed (after checking GET /v1/webhook_endpoints for it)'
        Would "update-function-configuration env: ORDERS_TOPIC_ARN=$OrdersTopicArn, STRIPE_WEBHOOK_SECRET=<whsec from the creation response>"
    } else {
        # GET /v1/webhook_endpoints is read-only, so it runs under -DryRun
        # too - like the AWS reads, it doubles as a drift check. Trailing
        # slashes are normalized on both sides: AWS reports function URLs
        # with one, and what Stripe stores is whatever was POSTed.
        $endpoints = Get-StripeList -Path '/v1/webhook_endpoints?limit=100'
        $wantedUrl = $WebhookUrl.TrimEnd('/')
        $existingEndpoint = $endpoints |
            Where-Object { "$($_.url)".TrimEnd('/') -eq $wantedUrl } |
            Select-Object -First 1

        if ($existingEndpoint) {
            # Stripe returns the whsec_ secret exactly once, at creation, so
            # an existing endpoint means the env was set by the run that
            # created it. get-function-configuration (a read) verifies that
            # assumption without printing anything: only the whsec_ prefix
            # is tested, never shown.
            $whCfgRaw    = aws lambda get-function-configuration --function-name $WebhookFnName --region $Region --output json 2>&1
            $whSecretNow = if ($LASTEXITCODE -eq 0) { ($whCfgRaw | ConvertFrom-Json).Environment.Variables.STRIPE_WEBHOOK_SECRET } else { $null }
            if ($whSecretNow -and $whSecretNow.StartsWith('whsec_')) {
                Ok "endpoint exists: $($existingEndpoint.id) - STRIPE_WEBHOOK_SECRET is a whsec_ value, env assumed current"
            } else {
                Warn "endpoint exists ($($existingEndpoint.id)) but the Lambda's STRIPE_WEBHOOK_SECRET is not a whsec_ value - signature checks will fail"
            }
            Warn 'The secret is not retrievable after creation. To rotate: delete the endpoint (Stripe dashboard -> Developers -> Webhooks, or DELETE /v1/webhook_endpoints/<id>) and re-run this script.'
        } elseif ($DryRun) {
            Would "POST /v1/webhook_endpoints url=$WebhookUrl enabled_events[]=checkout.session.completed"
            Would "update-function-configuration env: ORDERS_TOPIC_ARN=$OrdersTopicArn, STRIPE_WEBHOOK_SECRET=<whsec from the creation response>"
        } else {
            $createdEndpoint = Invoke-Stripe -Method POST -Path '/v1/webhook_endpoints' -Body @{
                url                = $WebhookUrl
                'enabled_events[]' = 'checkout.session.completed'
                description        = 'geniesolos.com order notifications (created by scripts/setup-aws.ps1)'
            }
            $WebhookSecret = $createdEndpoint.secret
            if ([string]::IsNullOrWhiteSpace($WebhookSecret) -or -not $WebhookSecret.StartsWith('whsec_')) {
                throw "webhook endpoint $($createdEndpoint.id) was created but no whsec secret came back - delete it in Stripe and re-run."
            }
            Ok "endpoint created: $($createdEndpoint.id) (whsec_... captured, never printed)"

            # The one shot at the secret: write BOTH env vars now, in a
            # single update-function-configuration, via file:// exactly like
            # the checkout env in step 3, replacing the placeholder.
            $realEnvObj = [ordered]@{
                Variables = [ordered]@{
                    ORDERS_TOPIC_ARN      = $OrdersTopicArn
                    STRIPE_WEBHOOK_SECRET = $WebhookSecret
                }
            }
            $realEnvFile = Join-Path $env:TEMP "geniesolos-orders-webhook-realenv-$PID.json"
            $realEnvObj | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $realEnvFile -Encoding utf8
            $realCfg = aws lambda update-function-configuration --function-name $WebhookFnName `
                --environment "file://$realEnvFile" --region $Region --output json 2>&1
            Remove-Item $realEnvFile -ErrorAction SilentlyContinue
            if ($LASTEXITCODE -ne 0) { throw "update-function-configuration failed: $realCfg" }
            aws lambda wait function-updated --function-name $WebhookFnName --region $Region
            Ok "env set: ORDERS_TOPIC_ARN=$OrdersTopicArn, STRIPE_WEBHOOK_SECRET=whsec_... (masked)"
        }
    }

    # ---------------------------------------------------------------- 13
    Step 13 'Webhook smoke tests'

    # Same gating as the step 7 smoke tests. The webhook URL is public and
    # sits outside CloudFront, so no x-amz-content-sha256 dance here: a GET
    # proves the URL is reachable and the handler's method gate answers, and
    # a garbage unsigned POST proves the signature check rejects before any
    # SNS or Stripe work happens.
    if ($DryRun) {
        Ok 'skipped for dry run'
    } elseif (-not $WebhookUrl) {
        Warn 'no webhook URL known, skipping'
    } else {
        try {
            $w1 = Invoke-WebRequest -Method Get -Uri $WebhookUrl -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 30
            if ($w1.StatusCode -eq 405) { Ok "GET $WebhookUrl -> 405 as expected" }
            else { Warn "GET $WebhookUrl -> $($w1.StatusCode), expected 405" }
        } catch {
            Warn "webhook GET failed: $($_.Exception.Message)"
        }

        try {
            $w2 = Invoke-WebRequest -Method Post -Uri $WebhookUrl -Body '{"garbage":true}' `
                -ContentType 'application/json' -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 30
            if ($w2.StatusCode -eq 400) { Ok "POST $WebhookUrl (unsigned garbage) -> 400 as expected" }
            else { Warn "POST $WebhookUrl (unsigned garbage) -> $($w2.StatusCode), expected 400" }
        } catch {
            Warn "webhook POST failed: $($_.Exception.Message)"
        }
    }

    # Reads that probe for not-yet-created resources (get-topic-attributes,
    # get-function, get-function-url-config) leave their tolerated non-zero
    # exit code in $LASTEXITCODE, and under -DryRun no later call overwrites
    # it - without this reset a completed dry run looks failed to any caller
    # that checks the exit code. Real errors still throw well before here.
    $global:LASTEXITCODE = 0

    Write-Host "`nDone." -ForegroundColor Green
}
finally { Pop-Location }
