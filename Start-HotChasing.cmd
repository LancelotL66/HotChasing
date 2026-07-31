@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-HotChasing.ps1"
if errorlevel 1 (
  echo.
  echo HotChasing could not be started. Review the message above.
  pause
)
