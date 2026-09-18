#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$InstallerPath,
    [ValidateRange(30, 600)]
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$installer = (Get-Item -LiteralPath $InstallerPath).FullName
$suffix = [Guid]::NewGuid().ToString('N')
$userName = "obinstall_$($suffix.Substring(0, 10))"
$workRoot = Join-Path $env:ProgramData "OpenBot-installer-user-$suffix"
$installRoot = Join-Path $workRoot 'installed'
$userCreated = $false
$directoryCreated = $false
$process = $null
$userSid = $null
$password = $null
$securePassword = $null
$passwordBytes = New-Object byte[] 48
$random = [Security.Cryptography.RandomNumberGenerator]::Create()

try {
    $random.GetBytes($passwordBytes)
    $password = 'aZ9!' + [Convert]::ToBase64String($passwordBytes)
    $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
    $user = New-LocalUser -Name $userName -Password $securePassword -Description 'OpenBot installer standard-user regression' -AccountExpires (Get-Date).AddHours(1)
    $userCreated = $true
    $userSid = $user.SID

    $usersSid = [Security.Principal.SecurityIdentifier]'S-1-5-32-545'
    Add-LocalGroupMember -SID $usersSid -Member $user
    $memberships = @(Get-LocalGroup | Where-Object {
        @(Get-LocalGroupMember -SID $_.SID | Where-Object { $_.SID -eq $userSid }).Count -gt 0
    })
    if ($memberships.Count -ne 1 -or $memberships[0].SID -ne $usersSid) {
        throw 'The temporary installer account must belong only to the local Users group.'
    }

    New-Item -ItemType Directory -Path $workRoot | Out-Null
    $directoryCreated = $true
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', $userSid.Value)) {
        $rights = if ($sid -eq $userSid.Value) { 'Modify' } else { 'FullControl' }
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            [Security.Principal.SecurityIdentifier]$sid, $rights,
            'ContainerInherit, ObjectInherit', 'None', 'Allow'
        )
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $workRoot -AclObject $acl

    $copiedInstaller = Join-Path $workRoot 'openbot-setup.exe'
    Copy-Item -LiteralPath $installer -Destination $copiedInstaller

    $wrapper = @'
param(
    [Parameter(Mandatory)][string]$ExpectedSid,
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$InstallDir
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$exitCode = 1
$app = $null
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User.Value -ne $ExpectedSid) { throw 'Wrong temporary user.' }
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Installer acceptance unexpectedly has administrator privileges.'
    }

    $profile = [Environment]::GetFolderPath('UserProfile')
    $registered = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$ExpectedSid").ProfileImagePath
    if (-not $profile -or $profile -ne [Environment]::ExpandEnvironmentVariables($registered)) {
        throw 'The temporary installer account profile was not loaded.'
    }

    $installed = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$InstallDir") -Wait -PassThru
    if ($installed.ExitCode -ne 0) { throw "NSIS installer exited with $($installed.ExitCode)." }

    $appPath = Join-Path $InstallDir 'openbot-desktop.exe'
    if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
        throw 'Installer completed but openbot-desktop.exe does not exist at the install root.'
    }

    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcut = Join-Path $desktop 'OpenBot.lnk'
    if (-not (Test-Path -LiteralPath $shortcut -PathType Leaf)) {
        throw 'Installer completed but did not create OpenBot.lnk on the standard user desktop.'
    }
    $wsh = New-Object -ComObject WScript.Shell
    $link = $wsh.CreateShortcut($shortcut)
    if ([IO.Path]::GetFullPath($link.TargetPath) -ne [IO.Path]::GetFullPath($appPath)) {
        throw "Desktop shortcut points to $($link.TargetPath), expected $appPath."
    }

    $app = Start-Process -FilePath $appPath -PassThru
    Start-Sleep -Seconds 5
    $app.Refresh()
    if ($app.HasExited) { throw "Installed OpenBot exited during first launch (exit $($app.ExitCode))." }
    Stop-Process -Id $app.Id -Force
    Wait-Process -Id $app.Id -ErrorAction SilentlyContinue
    $app = $null

    $uninstallers = @(Get-ChildItem -LiteralPath $InstallDir -Recurse -Filter 'uninstall*.exe' -File)
    if ($uninstallers.Count -ne 1) { throw "Expected one uninstaller, found $($uninstallers.Count)." }
    $removed = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList '/S' -Wait -PassThru
    if ($removed.ExitCode -ne 0) { throw "NSIS uninstaller exited with $($removed.ExitCode)." }

    for ($attempt = 0; $attempt -lt 30 -and (Test-Path -LiteralPath $appPath); $attempt++) {
        Start-Sleep -Milliseconds 500
    }
    if (Test-Path -LiteralPath $appPath) { throw 'Application remains after uninstall.' }
    if (Test-Path -LiteralPath $shortcut) {
        throw 'Desktop shortcut remains after uninstall.'
    }

    [ordered]@{ identity = $identity.Name; sid = $ExpectedSid; elevated = $false; installerExit = $installed.ExitCode; uninstallerExit = $removed.ExitCode; desktopShortcut = 'created-and-removed' } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'acceptance.json')
    $exitCode = 0
} catch {
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'wrapper-error.log')
} finally {
    if ($null -ne $app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
    @{ exitCode = $exitCode } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'result.tmp')
    Move-Item -LiteralPath (Join-Path $PSScriptRoot 'result.tmp') -Destination (Join-Path $PSScriptRoot 'result.json') -Force
}
exit $exitCode
'@

    $wrapperPath = Join-Path $workRoot 'run-installer.ps1'
    Set-Content -LiteralPath $wrapperPath -Value $wrapper -Encoding UTF8
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$userName", $securePassword)
    $argumentLine = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$wrapperPath`" -ExpectedSid $($userSid.Value) -Installer `"$copiedInstaller`" -InstallDir `"$installRoot`""
    $process = Start-Process -FilePath $powershell -Credential $credential -LoadUserProfile -WorkingDirectory $workRoot -WindowStyle Hidden -PassThru -ArgumentList $argumentLine

    $password = $null
    $securePassword.Dispose()
    $securePassword = $null
    [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)

    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        throw "Standard-user installer acceptance timed out after $TimeoutSeconds seconds."
    }
    $resultPath = Join-Path $workRoot 'result.json'
    if (-not (Test-Path -LiteralPath $resultPath)) {
        throw "Standard-user installer wrapper exited without a result (exit $($process.ExitCode))."
    }
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if ($result.exitCode -ne 0) { throw "Standard-user installer acceptance failed with exit $($result.exitCode)." }
    $acceptance = Get-Content -LiteralPath (Join-Path $workRoot 'acceptance.json') -Raw | ConvertFrom-Json
    if ($acceptance.elevated -ne $false -or $acceptance.sid -ne $userSid.Value) {
        throw 'Acceptance evidence did not come from the expected non-admin account.'
    }
    Write-Host 'Verified NSIS install, first launch, and uninstall as a real Windows standard user.'
} finally {
    $password = $null
    if ($null -ne $securePassword) { $securePassword.Dispose() }
    [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
    $random.Dispose()

    $cleanupErrors = @()
    if ($null -ne $process) {
        if (-not $process.HasExited) {
            try {
                & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
                if ($LASTEXITCODE -ne 0 -and -not $process.HasExited) { throw 'Could not stop installer acceptance process tree.' }
                if (-not $process.WaitForExit(10000)) { throw 'Installer acceptance process did not stop.' }
            } catch { $cleanupErrors += $_.Exception.Message }
        }
        try { $process.Dispose() } catch { $cleanupErrors += $_.Exception.Message }
        $process = $null
    }
    if ($directoryCreated) {
        foreach ($name in @('acceptance.json', 'wrapper-error.log', 'result.json')) {
            $path = Join-Path $workRoot $name
            if (Test-Path -LiteralPath $path) { Write-Host "----- $name -----"; Get-Content -LiteralPath $path }
        }
    }
    if ($userCreated) {
        # A credentialed PowerShell can have exited while Windows is still unloading that user's
        # profile hive. Removing Win32_UserProfile in that window fails with ERROR_SHARING_VIOLATION
        # even though install/launch/uninstall already succeeded. Retry the unload/removal boundary
        # rather than weakening the acceptance result or ignoring a profile that really stayed live.
        $profileRemoved = $false
        for ($attempt = 0; $attempt -lt 30 -and -not $profileRemoved; $attempt++) {
            try {
                $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$($userSid.Value)'" -ErrorAction Stop
                if ($null -eq $profile) {
                    $profileRemoved = $true
                    break
                }
                if ($profile.Loaded) {
                    if ($attempt -lt 29) { Start-Sleep -Milliseconds 500 }
                    continue
                }
                $profile | Remove-CimInstance -ErrorAction Stop
                $profileRemoved = $true
            } catch {
                if ($attempt -eq 29) {
                    $cleanupErrors += $_.Exception.Message
                } else {
                    Start-Sleep -Milliseconds 500
                }
            }
        }
        if (-not $profileRemoved) {
            $cleanupErrors += 'The temporary standard-user profile stayed loaded after the acceptance process exited.'
        }

        $userRemoved = $false
        for ($attempt = 0; $attempt -lt 10 -and -not $userRemoved; $attempt++) {
            try {
                Remove-LocalUser -SID $userSid -ErrorAction Stop
                $userRemoved = $true
            } catch {
                if ($attempt -eq 9) {
                    $cleanupErrors += $_.Exception.Message
                } else {
                    Start-Sleep -Milliseconds 500
                }
            }
        }
    }
    if ($directoryCreated) {
        for ($attempt = 0; $attempt -lt 30 -and (Test-Path -LiteralPath $workRoot); $attempt++) {
            try {
                Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction Stop
            } catch {
                if ($attempt -eq 29) {
                    $cleanupErrors += $_.Exception.Message
                } else {
                    Start-Sleep -Milliseconds 500
                }
            }
        }
    }
    if ($cleanupErrors.Count -gt 0) { throw "Standard-user installer cleanup failed: $($cleanupErrors -join '; ')" }
}
