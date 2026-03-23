@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM  Water Favorability Explorer – Windows launcher
REM  Mirrors the GRACE–TC–Geology Explorer START.bat pattern.
REM ─────────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

echo.
echo  ================================================
echo   Water Favorability Explorer  ^|  HF v1
echo  ================================================
echo.

REM ── Check Node ─────────────────────────────────────────────────────────────
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  [ERROR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

REM ── Check Python ───────────────────────────────────────────────────────────
where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  [ERROR] Python not found. Install from https://python.org
    pause
    exit /b 1
)

REM ── Install Node deps if needed ────────────────────────────────────────────
if not exist "node_modules" (
    echo  Installing Node.js dependencies...
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo  [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

REM ── Install Python deps if needed ──────────────────────────────────────────
python -c "import rasterio" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  Installing Python dependencies...
    python -m pip install -r python\requirements.txt
    if %ERRORLEVEL% NEQ 0 (
        echo  [WARNING] Some Python packages may not have installed correctly.
        echo            The app will use synthetic layers if rasterio is missing.
    )
)

REM ── Launch dev server ──────────────────────────────────────────────────────
echo.
echo  Starting development server on http://localhost:5000
echo  Press Ctrl+C to stop.
echo.

set NODE_ENV=development
call npx tsx server\index.ts

pause
