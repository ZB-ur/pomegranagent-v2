@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  py -3.12 -m venv .venv
  if errorlevel 1 (
    echo Install Python 3.12 x64 from python.org, then try again.
    pause
    exit /b 1
  )
)
".venv\Scripts\python.exe" scripts\setup_voice.py
if errorlevel 1 (
  pause
  exit /b 1
)
echo Ready. Open launch.bat to start the diary.
pause
