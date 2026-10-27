@echo off
rem Build the SchReader Android APK.
rem Mirror the extension's reader page + extractor into app assets first, so the
rem phone always ships the same code as the Chrome extension, then build.
setlocal
cd /d "%~dp0"

if "%JAVA_HOME%"=="" set JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot
if not exist "%JAVA_HOME%\bin\java.exe" (
  echo [android] JDK not found at %JAVA_HOME% - install Temurin 21 or set JAVA_HOME.
  exit /b 1
)

if not exist "local.properties" (
  echo sdk.dir=%LOCALAPPDATA:\=\\%\\Android\\Sdk> local.properties
)

python3 tools\mirror.py
if errorlevel 1 (
  echo [android] asset mirror FAILED
  exit /b 1
)

call gradlew.bat assembleDebug
if errorlevel 1 (
  echo [android] BUILD FAILED
  exit /b 1
)

echo [android] OK -^> android\app\build\outputs\apk\debug\app-debug.apk
endlocal
