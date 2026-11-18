@echo off
rem AeroCallout im iPhone-Simulator (WebKit, iPhone 15) starten. Optionen: --gps static, --gps denied, --landscape, --mute
cd /d "%~dp0"
set PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
if not exist "%PY%" set PY=python
"%PY%" -c "import playwright" 2>nul || ("%PY%" -m pip install playwright && "%PY%" -m playwright install webkit)
"%PY%" ios_sim.py %*
pause
