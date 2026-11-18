# Builds the AeroCallout APK and installs it on a connected phone (USB or wireless debugging).
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\nkrau\AndroidDev'
$env:JAVA_HOME = "$root\jdk"; $env:ANDROID_HOME = "$root\sdk"; $env:GRADLE_USER_HOME = "$root\gradle-home"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here
try {
    cmd /c "`"$root\gradle-8.7\bin\gradle.bat`" assembleDebug --no-daemon --console=plain -q > `"$root\build.log`" 2>&1"
    if ($LASTEXITCODE -ne 0) { Get-Content "$root\build.log" -Tail 30; throw 'Build fehlgeschlagen' }
    $apk = Join-Path $here 'app\build\outputs\apk\debug\app-debug.apk'
    Copy-Item $apk (Join-Path (Split-Path $here -Parent) 'AeroCallout.apk') -Force
    Write-Output 'Build OK, APK aktualisiert.'
    $adb = "$root\sdk\platform-tools\adb.exe"
    $dev = & $adb devices | Where-Object { $_ -match "`tdevice$" }
    if ($dev) {
        # Installer = Play Store: Android Auto shows the app in the car even when its developer
        # setting "Unknown sources" is off (it resets e.g. after Android Auto updates).
        & $adb install -r -i com.android.vending $apk
        & $adb shell am force-stop org.aerocallout.app
        & $adb shell am start -n org.aerocallout.app/.MainActivity | Out-Null
        Write-Output 'Auf dem Handy installiert und gestartet.'
    } else { Write-Output 'Kein Handy verbunden - nur gebaut.' }
} finally { Pop-Location }
