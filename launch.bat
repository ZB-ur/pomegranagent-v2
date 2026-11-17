@echo off
cd /d "%~dp0"
if exist ".runtime\python\python.exe" (
  set "PYTHONPATH=%~dp0.runtime\app-packages"
  set "PYTHONNOUSERSITE=1"
  ".runtime\python\python.exe" server.py --open %*
  if errorlevel 1 pause
  exit /b
)
if not exist ".venv\Scripts\python.exe" (
  call setup-voice.bat --no-pause
  if errorlevel 1 exit /b 1
)
".venv\Scripts\python.exe" scripts\setup_voice.py --check
if errorlevel 1 (
  call setup-voice.bat --no-pause
  if errorlevel 1 exit /b 1
)
".venv\Scripts\python.exe" server.py --open %*
if errorlevel 1 pause
