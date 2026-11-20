@echo off
setlocal
cd /d "%~dp0"

echo ===================================================================
echo                     Starting HostelCode Dev Stack
echo ===================================================================
echo.

if not exist "node_modules" (
  echo [*] Installing dependencies...
  call npm.cmd install
)

if not exist "packages\shared\dist" (
  echo [*] Building shared package...
  call npm.cmd run build:shared
)

echo.
echo [*] Collaboration Server: ws://localhost:1234, http://localhost:1234
echo [*] Web Frontend:        http://localhost:5173
echo.
echo ===================================================================
echo   Press Ctrl+C in this terminal window to stop all services.
echo ===================================================================
echo.

start /b cmd /c "ping 127.0.0.1 -n 4 >nul && start http://localhost:5173"

call npm.cmd run dev

pause
