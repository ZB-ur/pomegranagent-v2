@echo off
setlocal
cd /d "%~dp0"
if exist ".runtime\python\python.exe" (
  set "PYTHONPATH=%~dp0.runtime\app-packages"
  set "PYTHONNOUSERSITE=1"
  set "DUCK_PYTHON=.runtime\python\python.exe"
  goto install_voice
)
if not exist ".venv\Scripts\python.exe" (
  py -3.12 -m venv .venv
  if errorlevel 1 (
    echo Install Python 3.12 x64 from python.org, then try again.
    pause
    exit /b 1
  )
)
set "DUCK_PYTHON=.venv\Scripts\python.exe"
:install_voice
"%DUCK_PYTHON%" scripts\setup_voice.py
if errorlevel 1 (
  pause
  exit /b 1
)
echo Ready. Open launch.bat to start the diary.
if not "%~1"=="--no-pause" pause
