@echo off
setlocal
cd /d "%~dp0"

set "USE_PYINSTALLER_CMD="

where pyinstaller >nul 2>nul
if not errorlevel 1 (
  set "USE_PYINSTALLER_CMD=pyinstaller"
) else (
  python -c "import PyInstaller" >nul 2>nul
  if not errorlevel 1 (
    set "USE_PYINSTALLER_CMD=python -m PyInstaller"
  )
)

if "%USE_PYINSTALLER_CMD%"=="" (
  echo PyInstaller is not installed in the system environment.
  echo Install it first, then re-run this script.
  exit /b 1
)

echo Building s3explorer Windows package...
%USE_PYINSTALLER_CMD% ^
  --noconfirm ^
  --clean ^
  --name s3explorer ^
  --onedir ^
  --add-data "static;static" ^
  server.py
if errorlevel 1 exit /b %errorlevel%

echo.
echo Build complete.
echo Output folder: dist\s3explorer
endlocal
