@echo off
setlocal
cd /d "%~dp0"
set "DUCK_TTS_BACKEND=bf16"
echo Starting the original BF16 comparison backend. Close any other diary window/server first.
call launch.bat %*
exit /b %errorlevel%
