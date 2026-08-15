<#
.SYNOPSIS
    Wires the geniesolos-checkout Lambda behind https://geniesolos.com/api/*.

.DESCRIPTION
    Idempotent setup for the checkout backend: an IAM role, the Lambda
    function and its environment variables, an AWS_IAM function URL that
    CloudFront is allowed to invoke, an Origin Access Control for it, and a
    CloudFront distribution patch that adds a checkout-lambda origin plus an
    /api/* cache behavior. Every step is get-then-create, so running this a
    second time after a successful run finds everything already in place and
    changes nothing.

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
    the apply, even after the diff, and every other mutating AWS call in this
    script (create-role, create-function, update-function-code,
    update-function-configuration, create-function-url-config, add-permission,
    create-origin-access-control, update-distribution) is gated the same way.

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
    [switch]$DryRun
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

$RepoRoot = Split-Path -Parent $PSScriptRoot
$KeyFile  = Join-Path $RepoRoot "scripts\.secrets\stripe-$Mode.key"
$MapFile  = Join-Path $RepoRoot "scripts\price-map.$Mode.json"
$FnSource = Join-Path $RepoRoot 'api\checkout\index.mjs'

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

    $SourceArn = "arn:aws:cloudfront::${Account}:distribution/$DistributionId"
    if ($DryRun) {
        Would "add-permission cloudfront-invoke (lambda:InvokeFunctionUrl, principal cloudfront.amazonaws.com, source-arn $SourceArn)"
    } else {
        $permRaw  = aws lambda add-permission --function-name $FnName --statement-id cloudfront-invoke `
            --action lambda:InvokeFunctionUrl --principal cloudfront.amazonaws.com `
            --source-arn $SourceArn --function-url-auth-type AWS_IAM `
            --region $Region --output json 2>&1
        $permExit = $LASTEXITCODE
        $perm     = $permRaw -join "`n"
        if ($permExit -eq 0) {
            Ok 'permission cloudfront-invoke added'
        } elseif ($perm -match 'ResourceConflictException') {
            Ok 'permission cloudfront-invoke already present'
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
        $hasBehavior = [bool]($distCfg.CacheBehaviors.Items | Where-Object { $_.PathPattern -eq '/api/*' })
    }

    if ($hasOrigin -and $hasBehavior) {
        Ok 'checkout-lambda origin and /api/* behavior already present, nothing to change'
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
  "PathPattern": "/api/*",
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
            $answer = Read-Host 'Apply this CloudFront change? (y/N)'
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
        # Empty body: JSON.parse('') fails before any Stripe call, so this
        # proves routing + Lambda + validation without spending a Stripe call.
        try {
            $r1 = Invoke-WebRequest -Method Post -Uri 'https://geniesolos.com/api/checkout' -Body '' `
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

    Write-Host "`nDone." -ForegroundColor Green
}
finally { Pop-Location }
