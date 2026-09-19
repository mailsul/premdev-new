@echo off
setlocal
echo ===================================================
echo   Push PremDev ke GitHub
echo ===================================================

REM Set PATH to include Git
set "PATH=%LOCALAPPDATA%\Programs\Git\cmd;%LOCALAPPDATA%\Programs\Git\bin;%PATH%"

REM Check git
where git >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Git tidak ditemukan!
    pause
    exit /b 1
)

REM Run push script using bash
bash push_to_github.sh

pause
