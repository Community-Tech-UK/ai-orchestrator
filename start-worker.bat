@echo off
setlocal
cd /d "%~dp0"

echo Building worker agent...
call npx tsx build-worker-agent.ts
if errorlevel 1 (
    echo Build failed.
    exit /b 1
)

REM Capture raw stderr. V8's fatal handler ("FATAL ERROR: ... JavaScript heap
REM out of memory") is written by C++ straight to fd 2 and bypasses the worker's
REM in-process file logger entirely, so without this redirect an OOM death
REM leaves no evidence anywhere.
REM
REM Local to this script only (hence setlocal) - the worker does NOT read this
REM variable; WorkerFileLogger always uses %USERPROFILE%\.orchestrator\logs.
REM Roll the previous run's file aside rather than appending forever: a fatal
REM error belongs to the run that died, and this bounds growth to two files.
set "_AIO_STDERR_DIR=%USERPROFILE%\.orchestrator\logs"
if not exist "%_AIO_STDERR_DIR%" mkdir "%_AIO_STDERR_DIR%" 2>nul
if exist "%_AIO_STDERR_DIR%\worker-stderr.log" (
    move /y "%_AIO_STDERR_DIR%\worker-stderr.log" "%_AIO_STDERR_DIR%\worker-stderr.log.1" >nul 2>nul
)

REM Drift check. The deployed launcher in %USERPROFILE%\.orchestrator is rendered
REM from scripts\windows\start-worker-autoupdate.template.bat by
REM install-worker-launcher.ps1, which records two hashes. Compare both:
REM   template - the repo moved on (this pull brought a new template).
REM   deployed - someone hand-edited the deployed launcher. That is the
REM              2026-09-03 failure mode; the template hash cannot see it.
REM
REM Warn ONLY. Rewriting the deployed .bat here would be rewriting the file that
REM is currently executing us, which is the byte-offset hazard that put it
REM outside the repo in the first place. Every step is failure-tolerant: a
REM missing stamp, missing certutil or odd output must never block startup.
REM
REM Delayed expansion is scoped to this block on purpose. Script-wide it would
REM also apply to %* on the node line below, mangling any argument containing
REM an exclamation mark.
setlocal EnableDelayedExpansion
set "_AIO_ORCH=%USERPROFILE%\.orchestrator"
set "_AIO_STALE="

set "_AIO_TSTAMP=%_AIO_ORCH%\launcher-template.sha256"
set "_AIO_TFILE=%~dp0scripts\windows\start-worker-autoupdate.template.bat"
if exist "%_AIO_TSTAMP%" if exist "%_AIO_TFILE%" (
    set "_AIO_TW="
    set "_AIO_TH="
    for /f "usebackq delims=" %%S in ("%_AIO_TSTAMP%") do if not defined _AIO_TW set "_AIO_TW=%%S"
    for /f "skip=1 delims=" %%H in ('certutil -hashfile "%_AIO_TFILE%" SHA256 2^>nul') do if not defined _AIO_TH set "_AIO_TH=%%H"
    set "_AIO_TH=!_AIO_TH: =!"
    if defined _AIO_TW if defined _AIO_TH if /i not "!_AIO_TW!"=="!_AIO_TH!" set "_AIO_STALE=1"
)

set "_AIO_DSTAMP=%_AIO_ORCH%\launcher-deployed.sha256"
set "_AIO_DFILE=%_AIO_ORCH%\start-worker-autoupdate.bat"
if exist "%_AIO_DSTAMP%" if exist "%_AIO_DFILE%" (
    set "_AIO_DW="
    set "_AIO_DH="
    for /f "usebackq delims=" %%S in ("%_AIO_DSTAMP%") do if not defined _AIO_DW set "_AIO_DW=%%S"
    for /f "skip=1 delims=" %%H in ('certutil -hashfile "%_AIO_DFILE%" SHA256 2^>nul') do if not defined _AIO_DH set "_AIO_DH=%%H"
    set "_AIO_DH=!_AIO_DH: =!"
    if defined _AIO_DW if defined _AIO_DH if /i not "!_AIO_DW!"=="!_AIO_DH!" set "_AIO_STALE=1"
)

if defined _AIO_STALE (
    echo.
    echo *** WARNING: the deployed worker launcher does not match the repo. ***
    echo     Either scripts\windows\start-worker-autoupdate.template.bat has changed,
    echo     or %%USERPROFILE%%\.orchestrator\start-worker-autoupdate.bat was hand-edited.
    echo     Re-run: powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker-launcher.ps1 -RepoPath "%CD%"
    echo.
)
endlocal

REM --supervise runs the worker under its own restart parent (worker-supervisor.ts).
REM Without it a single process exit leaves the node dead until someone notices:
REM on 2026-09-03 the worker died at 12:45 and stayed down for 23 hours because
REM this script simply ended and the launching `cmd /K` sat at a prompt.
REM
REM The flag goes LAST: index.ts dispatches positional subcommands off argv[0]
REM ("native-host", "pair", "install-extension-relay"), so putting it first would
REM shadow them. Supervision is selected with argv.includes(), not by position.
echo Starting worker agent (supervised)...
node dist/worker-agent/index.js %* --supervise 2>> "%_AIO_STDERR_DIR%\worker-stderr.log"
