#Requires -Version 7.0
param(
    [string]$ApplicationId = 'cb923310-e793-4557-929e-b33e49a42297',
    [string]$CredentialFile = (Join-Path $PSScriptRoot '../signing/azure-federation.json'),
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-AzJson {
    param([string[]]$Arguments)
    $output = & az @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed: $($output | Out-String)"
    }
    if ([string]::IsNullOrWhiteSpace(($output | Out-String))) {
        return $null
    }
    return ($output | Out-String) | ConvertFrom-Json
}

function Same-StringSet {
    param([object[]]$Left, [object[]]$Right)
    $a = @($Left | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    $b = @($Right | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    if ($a.Count -ne $b.Count) { return $false }
    return $null -eq (Compare-Object -ReferenceObject $a -DifferenceObject $b -CaseSensitive)
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI (az) is required.'
}
if (-not (Test-Path -LiteralPath $CredentialFile -PathType Leaf)) {
    throw "Federated credential file does not exist: $CredentialFile"
}

$expected = Get-Content -LiteralPath $CredentialFile -Raw | ConvertFrom-Json
foreach ($field in @('name', 'issuer', 'subject')) {
    if ([string]::IsNullOrWhiteSpace([string]$expected.$field)) {
        throw "Federated credential file is missing $field."
    }
}
if (@($expected.audiences).Count -eq 0) {
    throw 'Federated credential file is missing audiences.'
}

$existing = @(
    Invoke-AzJson @(
        'ad', 'app', 'federated-credential', 'list',
        '--id', $ApplicationId,
        '--only-show-errors',
        '--output', 'json'
    )
)

$exact = @(
    $existing | Where-Object {
        ([string]$_.issuer -ceq [string]$expected.issuer) -and
        ([string]$_.subject -ceq [string]$expected.subject) -and
        (Same-StringSet @($_.audiences) @($expected.audiences))
    }
)

if ($exact.Count -gt 0) {
    Write-Host "Federated credential already exists for subject: $($expected.subject)"
    exit 0
}

$nameCollision = @($existing | Where-Object { [string]$_.name -ceq [string]$expected.name })
if ($nameCollision.Count -gt 0) {
    throw "A federated credential named '$($expected.name)' already exists but does not match issuer/subject/audience. Refusing to overwrite it."
}

if ($CheckOnly) {
    throw "Federated credential is missing for subject: $($expected.subject)"
}

Write-Host "Creating federated credential '$($expected.name)' for subject: $($expected.subject)"
& az ad app federated-credential create --id $ApplicationId --parameters $CredentialFile --only-show-errors --output none
if ($LASTEXITCODE -ne 0) {
    throw 'Azure CLI could not create the federated credential.'
}

$after = @(
    Invoke-AzJson @(
        'ad', 'app', 'federated-credential', 'list',
        '--id', $ApplicationId,
        '--only-show-errors',
        '--output', 'json'
    )
)
$verified = @(
    $after | Where-Object {
        ([string]$_.issuer -ceq [string]$expected.issuer) -and
        ([string]$_.subject -ceq [string]$expected.subject) -and
        (Same-StringSet @($_.audiences) @($expected.audiences))
    }
)

if ($verified.Count -eq 0) {
    throw 'Federated credential create returned success but the expected issuer/subject/audience could not be verified.'
}

Write-Host 'Federated credential created and verified.'
