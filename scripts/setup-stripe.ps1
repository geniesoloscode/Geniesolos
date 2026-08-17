<#
.SYNOPSIS
    Reconciles the GenieSolos Stripe product/price catalog and writes
    scripts/price-map.<Mode>.json for the checkout Lambda to consume.

.DESCRIPTION
    Reads a Stripe secret key from scripts\.secrets\stripe-<Mode>.key (a file
    the user creates by hand; it is git-ignored and never touches this repo).
    For each catalog entry it reconciles a Stripe Product by exact name match
    and each of its Prices by amount/currency/interval, creating only what is
    missing, then writes the resulting price ids to
    scripts\price-map.<Mode>.json in the exact shape api/checkout/index.mjs's
    PRICE_MAP expects: { key: [priceId, ...] }, with storefront-build's
    recurring price first, its build deposit second and its build balance
    third.

    Idempotent by design: run it as many times as you like. Once every
    product and price exists, a second run finds everything and creates
    nothing.

    This script never prints the full secret key. It is loaded, sanity
    checked against $Mode, and used only in the Authorization header of
    requests to api.stripe.com - no log line, error message, or output ever
    contains more than "sk_xxxx_...xxxx".

.PARAMETER Mode
    'test' or 'live'. Selects which key file to read and which price-map
    file to write. Defaults to 'test' so a bare invocation can never touch
    live data by accident.

.EXAMPLE
    .\scripts\setup-stripe.ps1
    .\scripts\setup-stripe.ps1 -Mode live
#>
[CmdletBinding()]
param(
    [ValidateSet('test', 'live')]
    [string]$Mode = 'test'
)

$ErrorActionPreference = 'Stop'

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$KeyFile   = Join-Path $RepoRoot "scripts\.secrets\stripe-$Mode.key"
$MapFile   = Join-Path $RepoRoot "scripts\price-map.$Mode.json"
$StripeApi = 'https://api.stripe.com'

# Catalog: name -> price(s) in cents. storefront-build maps to THREE price ids
# in a fixed order - recurring, build deposit, build balance - because the
# approval runbook names them by position. Every other key is a one-element
# array. The Lambda treats a non-array or empty value as a config error, so
# this script always writes arrays - see the @() wrapping down in the
# JSON-write step.
#
# THE NAMES ARE CUSTOMER-FACING. They print on invoices and receipts, and
# reconciliation matches them EXACTLY - a different case, a space where there
# is a hyphen, or a missing word all read as a new product and create a
# duplicate rather than reusing the existing one. Owner's chosen scheme
# (2026-08-16): the three tier plans shout, everything else is title case.
#
# This list is shared by BOTH modes. It was retargeted to these names for the
# live build, so the test-mode account still holds the older 'GenieSolos X'
# products; running -Mode test against it will create duplicates until those
# are renamed or archived to match.
$Catalog = @(
    @{ Key = 'lifeline';         Name = 'LIFELINE';                   Prices = @(@{ Amount = 29900;  Recurring = $true }) }
    @{ Key = 'presence';         Name = 'PRESENCE';                   Prices = @(@{ Amount = 64900;  Recurring = $true }) }
    @{ Key = 'transformation';   Name = 'TRANSFORMATION';             Prices = @(@{ Amount = 99900;  Recurring = $true }) }
    @{ Key = 'storefront-zero';  Name = 'Storefront (zero-down)';     Prices = @(@{ Amount = 49900;  Recurring = $true }) }
    @{ Key = 'storefront-build'; Name = 'Storefront (build + care)';  Prices = @(
        @{ Amount = 14900;  Recurring = $true }
        @{ Amount = 225000; Recurring = $false; Nickname = 'Storefront build deposit (1 of 2)' }
        @{ Amount = 225000; Recurring = $false; Nickname = 'Storefront build balance (2 of 2)' }
    ) }
    @{ Key = 'server-care';      Name = 'Server Care';                Prices = @(@{ Amount = 22500;  Recurring = $true }) }
    @{ Key = 'db-care';          Name = 'Database Care';              Prices = @(@{ Amount = 17500;  Recurring = $true }) }
    @{ Key = 'workspace-admin';  Name = 'Workspace Admin';            Prices = @(@{ Amount = 19900;  Recurring = $true }) }
)

Push-Location $RepoRoot
try {
    function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
    function Ok($msg)       { Write-Host "    $msg" -ForegroundColor Green }
    function Warn($msg)     { Write-Host "    $msg" -ForegroundColor Yellow }

    # Shows at most the mode-identifying prefix (sk_test_/sk_live_, 8 chars)
    # plus the last 4 characters. Called on every path that mentions the key,
    # including error output, so a mistyped or wrong-mode key never leaks
    # more than that into a terminal, transcript, or CI log.
    function Mask-Key([string]$k) {
        if ([string]::IsNullOrEmpty($k) -or $k.Length -le 12) { return '****' }
        return "$($k.Substring(0, 8))...$($k.Substring($k.Length - 4))"
    }

    Write-Host "GenieSolos Stripe catalog setup - mode: $Mode" -ForegroundColor White

    # ---------------------------------------------------------------- 1
    Step 1 "Loading $Mode secret key"

    # Everything below this point (prefix check included) must run before any
    # network call. Nothing here reads the key's contents into a message.
    if (-not (Test-Path -LiteralPath $KeyFile)) {
        Warn "No key file found at scripts\.secrets\stripe-$Mode.key"
        Warn "Create it by hand with your Stripe $Mode secret key as the only"
        Warn "content (starts with sk_${Mode}_, no quotes, no trailing newline"
        Warn "required - it will be trimmed). See scripts\.secrets\README.txt."
        throw "Missing scripts\.secrets\stripe-$Mode.key - aborting before any Stripe API call."
    }

    $StripeKey = (Get-Content -LiteralPath $KeyFile -Raw).Trim()

    if ([string]::IsNullOrWhiteSpace($StripeKey)) {
        throw "scripts\.secrets\stripe-$Mode.key is empty. Put your Stripe $Mode secret key in it and try again."
    }

    # Restricted keys (rk_) are accepted alongside full secret keys (sk_), and
    # are what this project should be using: this script only needs write on
    # products, prices and webhook endpoints, so a key that can also refund or
    # read customer details is over-privileged for the job.
    #
    # The MODE segment is the part that carries weight. On 2026-08-16 a live
    # key was saved into stripe-test.key by mistake; this check is what stops
    # that reaching the wrong account, and it fires before any API call.
    if (-not ($StripeKey.StartsWith("sk_${Mode}_") -or $StripeKey.StartsWith("rk_${Mode}_"))) {
        Warn "scripts\.secrets\stripe-$Mode.key is not a $Mode key."
        Warn "Expected a key starting with 'sk_${Mode}_' or 'rk_${Mode}_'. Found: $(Mask-Key $StripeKey)"
        throw "Key mode does not match -Mode $Mode - aborting before any Stripe API call."
    }

    Ok "key loaded: $(Mask-Key $StripeKey)"

    # ---------------------------------------------------------------- 2
    Step 2 'Connecting to Stripe'

    # Form-encoded bodies: Stripe's API rejects JSON request bodies. Passing a
    # hashtable to -Body with this content type makes Invoke-RestMethod
    # urlencode it as key=value pairs, which also handles bracketed keys like
    # 'recurring[interval]' correctly.
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

    # Stripe list endpoints cap at 100 per page. The catalog here is small,
    # but auto-pagination keeps this correct if it grows past that.
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
        # Unary comma prevents PowerShell's pipeline from unrolling the list
        # into a fixed-size array on return. Without it, a caller that later
        # calls .Add() on the result (as the price loop does for a product
        # with 2+ existing prices) throws "Collection was of a fixed size."
        return ,$all
    }

    # Reconcile by exact name match against active products only, so a
    # renamed or archived product does not silently collide.
    function Get-OrCreateProduct {
        param([string]$Name, $Existing)
        $match = $Existing | Where-Object { $_.name -eq $Name } | Select-Object -First 1
        if ($match) { return @{ Product = $match; Created = $false } }
        $created = Invoke-Stripe -Method POST -Path '/v1/products' -Body @{ name = $Name; active = 'true' }
        return @{ Product = $created; Created = $true }
    }

    # A price is reused when it matches on amount + currency + cadence +
    # nickname. Nickname is in the rule because storefront-build now has TWO
    # one-time prices at the same amount - deposit and balance - which are
    # otherwise indistinguishable, and the second lookup would find the first
    # and write one id twice.
    #
    # Both sides are cast to [string] so an absent nickname compares equal to
    # Stripe's null. Every price created before nicknames existed has a null
    # nickname, and without the cast each would stop matching itself and be
    # duplicated on the next run.
    function Get-OrCreatePrice {
        param([string]$ProductId, [int]$Amount, [bool]$IsRecurring, [string]$Nickname, $Existing)
        $match = $Existing | Where-Object {
            $_.unit_amount -eq $Amount -and $_.currency -eq 'usd' -and
            ([string]$_.nickname -eq [string]$Nickname) -and (
                ($IsRecurring -and $_.recurring -and $_.recurring.interval -eq 'month') -or
                ((-not $IsRecurring) -and (-not $_.recurring))
            )
        } | Select-Object -First 1
        if ($match) { return @{ Price = $match; Created = $false } }

        $body = @{ product = $ProductId; unit_amount = "$Amount"; currency = 'usd' }
        if ($IsRecurring) { $body['recurring[interval]'] = 'month' }
        if ($Nickname) { $body['nickname'] = $Nickname }
        $created = Invoke-Stripe -Method POST -Path '/v1/prices' -Body $body
        return @{ Price = $created; Created = $true }
    }

    $AllProducts = Get-StripeList -Path '/v1/products?active=true&limit=100'
    Ok "found $($AllProducts.Count) existing active product(s)"

    # ---------------------------------------------------------------- 3
    Step 3 'Reconciling products and prices'

    # Price ids are not secrets (they identify a catalog entry, not money or
    # an account), so the report below prints them in full - no truncation.
    $Report = New-Object System.Collections.Generic.List[object]
    $PriceMap = [ordered]@{}

    foreach ($entry in $Catalog) {
        $prodResult = Get-OrCreateProduct -Name $entry.Name -Existing $AllProducts
        $product = $prodResult.Product
        $Report.Add([pscustomobject]@{ Key = $entry.Key; Type = 'product'; Detail = $entry.Name; Status = $(if ($prodResult.Created) { 'created' } else { 'found' }); Id = $product.id })

        # A brand-new product has no prices yet; skip the list call for it.
        if ($prodResult.Created) {
            $existingPrices = New-Object System.Collections.Generic.List[object]
        } else {
            $existingPrices = Get-StripeList -Path "/v1/prices?product=$($product.id)&active=true&limit=100"
        }

        $ids = New-Object System.Collections.Generic.List[string]
        foreach ($priceSpec in $entry.Prices) {
            $priceResult = Get-OrCreatePrice -ProductId $product.id -Amount $priceSpec.Amount -IsRecurring $priceSpec.Recurring -Nickname $priceSpec.Nickname -Existing $existingPrices
            $ids.Add($priceResult.Price.id)
            if ($priceResult.Created) { $existingPrices.Add($priceResult.Price) }

            $detail = if ($priceSpec.Recurring) { "`$$([math]::Round($priceSpec.Amount / 100, 2))/mo" } else { "`$$([math]::Round($priceSpec.Amount / 100, 2)) one-time" }
            if ($priceSpec.Nickname) { $detail = "$detail ($($priceSpec.Nickname))" }
            $Report.Add([pscustomobject]@{ Key = $entry.Key; Type = 'price'; Detail = $detail; Status = $(if ($priceResult.Created) { 'created' } else { 'found' }); Id = $priceResult.Price.id })
        }

        # @() forces the value to stay a genuine array type going into
        # ConvertTo-Json. Verified this keeps a 1-item array as a JSON array
        # rather than collapsing it to a bare scalar, which the Lambda would
        # reject (PRICE_MAP values must always be arrays).
        $PriceMap[$entry.Key] = @($ids.ToArray())
    }

    Write-Host ''
    Write-Host ("  {0,-18} {1,-8} {2,-46} {3,-8} {4}" -f 'KEY', 'TYPE', 'DETAIL', 'STATUS', 'ID') -ForegroundColor White
    foreach ($row in $Report) {
        $color = if ($row.Status -eq 'created') { 'Green' } else { 'DarkGray' }
        Write-Host ("  {0,-18} {1,-8} {2,-46} {3,-8} {4}" -f $row.Key, $row.Type, $row.Detail, $row.Status, $row.Id) -ForegroundColor $color
    }

    $createdCount = ($Report | Where-Object { $_.Status -eq 'created' }).Count
    $foundCount = $Report.Count - $createdCount
    Write-Host ''
    Ok "$foundCount found, $createdCount created"

    # ---------------------------------------------------------------- 4
    Step 4 "Writing $MapFile"

    $PriceMap | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $MapFile -Encoding utf8
    Ok "wrote $($PriceMap.Keys.Count) key(s) to scripts\price-map.$Mode.json"

    Write-Host "`nDone." -ForegroundColor Green
}
finally { Pop-Location }
