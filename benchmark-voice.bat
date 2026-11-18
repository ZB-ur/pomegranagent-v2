@echo off
setlocal
cd /d "%~dp0"
set "DUCK_TTS_BACKEND=gguf"
if exist ".runtime\python\python.exe" (
  set "PYTHONPATH=%~dp0.runtime\app-packages"
  set "PYTHONNOUSERSITE=1"
  set "DUCK_PYTHON=.runtime\python\python.exe"
  goto prepare
)
if not exist ".venv\Scripts\python.exe" (
  call setup-voice.bat --no-pause
  if errorlevel 1 exit /b 1
)
set "DUCK_PYTHON=.venv\Scripts\python.exe"
:prepare
echo Close the diary server before comparing. Keep the laptop plugged in.
echo First-time BF16 setup downloads PyTorch and the original weights.
"%DUCK_PYTHON%" scripts\setup_voice.py --backend gguf --check
if errorlevel 1 "%DUCK_PYTHON%" scripts\setup_voice.py --backend gguf
if errorlevel 1 goto failed
"%DUCK_PYTHON%" scripts\setup_voice.py --backend bf16 --check
if errorlevel 1 "%DUCK_PYTHON%" scripts\setup_voice.py --backend bf16
if errorlevel 1 goto failed
"%DUCK_PYTHON%" scripts\benchmark_voice.py --backends gguf bf16 %*
if errorlevel 1 goto failed
echo Results and a shareable ZIP are saved in voice-benchmarks.
pause
exit /b 0
:failed
echo Comparison did not finish. Keep the report and console output for diagnosis.
pause
exit /b 1
