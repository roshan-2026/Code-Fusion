@echo off
setlocal

:: Switch to the directory where this script is located
cd /d "%~dp0"

echo ===================================================================
echo                     Starting HostelCode Dev Stack
echo ===================================================================
echo.

:: Check Node.js installation
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not found in your PATH. Please install Node.js 18 or higher.
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules" goto do_install
goto check_shared

:do_install
echo [*] Installing dependencies...
call npm.cmd install
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

:check_shared
:: Check if packages/shared/dist exists
if not exist "packages\shared\dist" goto do_build_shared
goto run_app

:do_build_shared
echo [*] Building shared package...
call npm.cmd run build:shared
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to build @hostelcode/shared.
    pause
    exit /b 1
)

:run_app
echo.
echo [*] Collaboration Server: ws://localhost:1234, http://localhost:1234
echo [*] Web Frontend:        http://localhost:5173
echo.
echo ===================================================================
echo   Press Ctrl+C in this terminal window to stop all services.
echo ===================================================================
echo.

:: Automatically open default browser after a 3-second delay
start /b cmd /c "ping 127.0.0.1 -n 4 >nul && start http://localhost:5173"

:: Start both frontend and backend concurrently
call npm.cmd run dev

pause
