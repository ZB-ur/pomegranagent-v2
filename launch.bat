@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run setup-voice.bat first to prepare local Chinese speech.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" server.py --open %*
if errorlevel 1 pause
