@echo off
rem Installiert AeroCallout.apk auf dem Handy - per USB-Kabel (oder kabellosem Debugging, falls verbunden).
rem Die App wird mit dem Play Store als Installationsquelle eingetragen. Dadurch zeigt Android Auto sie
rem im Auto an, auch wenn dort "Unbekannte Quellen" ausgeschaltet ist.
rem Voraussetzung auf dem Handy: Entwickleroptionen -> USB-Debugging an, beim Anstecken "Zulassen".
setlocal
set "ADB=%USERPROFILE%\AndroidDev\sdk\platform-tools\adb.exe"
set "APK=%~dp0AeroCallout.apk"
echo Suche Handy ...
"%ADB%" wait-for-device
echo Installiere AeroCallout ...
"%ADB%" install -r -i com.android.vending "%APK%"
if errorlevel 1 (
  echo.
  echo Installation fehlgeschlagen. Ist USB-Debugging an und wurde der PC auf dem Handy zugelassen?
  pause
  exit /b 1
)
"%ADB%" shell am start -n org.aerocallout.app/.MainActivity >nul
echo.
echo Fertig. AeroCallout ist installiert und erscheint jetzt auch in Android Auto.
pause
