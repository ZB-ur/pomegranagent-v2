@echo off
setlocal
cd /d "%~dp0"
if exist ".runtime\python\python.exe" (
  set "PYTHONPATH=%~dp0.runtime\app-packages"
  set "PYTHONNOUSERSITE=1"
  set "DUCK_PYTHON=.runtime\python\python.exe"
  goto check_voice
)
if not exist ".venv\Scripts\python.exe" (
  call setup-voice.bat --no-pause
  if errorlevel 1 exit /b 1
)
set "DUCK_PYTHON=.venv\Scripts\python.exe"
:check_voice
"%DUCK_PYTHON%" scripts\setup_voice.py --check
if errorlevel 1 (
  call setup-voice.bat --no-pause
  if errorlevel 1 exit /b 1
)
"%DUCK_PYTHON%" server.py --open %*
if errorlevel 1 pause
