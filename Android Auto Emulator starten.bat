@echo off
rem Startet den Android-Auto-Emulator (Desktop Head Unit) im Format eines VW ID.3 (1920 x 720).
rem Vorher auf dem Handy in Android Auto: Drei-Punkte-Menue -> "Head Unit Server starten".
rem Die Meldungen des Emulators gehen in eine Logdatei - so kann ein Klick ins Konsolenfenster
rem den Emulator nicht mehr anhalten (Windows-Markiermodus).
setlocal
set "ADB=%USERPROFILE%\AndroidDev\sdk\platform-tools\adb.exe"
set "DHU=%USERPROFILE%\AndroidDev\sdk\extras\google\auto"
set "CFG=%~dp0android\id3-headunit.ini"
set "LOG=%TEMP%\aerocallout-dhu.log"
"%ADB%" forward tcp:5277 tcp:5277 >nul
start "Android Auto Emulator" /min /d "%DHU%" cmd /c ""%DHU%\desktop-head-unit.exe" -c "%CFG%" > "%LOG%" 2>&1"
