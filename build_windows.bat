@echo off
setlocal
cd /d "%~dp0"

set "USE_PYINSTALLER_CMD="
set "PACKAGE_ARCH=%PROCESSOR_ARCHITECTURE%"

if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "PACKAGE_ARCH=AMD64"
if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "PACKAGE_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "PACKAGE_ARCH=arm64"
if /i "%PACKAGE_ARCH%"=="AMD64" set "PACKAGE_ARCH=x64"
set "PACKAGE_NAME=s3explorer-windows-%PACKAGE_ARCH%.zip"

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

if exist "dist\%PACKAGE_NAME%" del /f /q "dist\%PACKAGE_NAME%"
powershell -NoProfile -Command "Compress-Archive -Path 'dist\s3explorer' -DestinationPath 'dist\%PACKAGE_NAME%'"
if errorlevel 1 exit /b %errorlevel%

echo.
echo Build complete.
echo Output folder: dist\s3explorer
echo Release archive: dist\%PACKAGE_NAME%
endlocal
