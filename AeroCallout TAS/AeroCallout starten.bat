@echo off
title AeroCallout TAS
cd /d "%~dp0"
echo Starte AeroCallout ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
if errorlevel 1 pause
