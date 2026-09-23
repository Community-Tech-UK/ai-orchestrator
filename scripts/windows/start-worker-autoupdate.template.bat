@echo off
REM ---------------------------------------------------------------------------
REM Stable launcher for the AI Orchestrator worker node. TEMPLATE.
REM
REM Source of truth: scripts/windows/start-worker-autoupdate.template.bat
REM Deployed to:     %USERPROFILE%\.orchestrator\start-worker-autoupdate.bat
REM Deploy with:     scripts\windows\install-worker-launcher.ps1
REM The installer fills in the REPO value below.
REM
REM The scheduled task points to this deployed copy outside the repo. The
REM installer renders it from a tracked template so launcher drift is visible.
REM
REM Keep this file MINIMAL and STABLE. Anything that might need to change belongs
REM in start-worker.bat. Updating the checkout is a manual maintenance action.
REM
REM Keep this file pure ASCII: the installer writes it with ASCII encoding, so
REM smart quotes or dashes would be corrupted on write.
REM ---------------------------------------------------------------------------
setlocal
set "REPO=__REPO_PATH__"

cd /d "%REPO%" || (echo Repo not found: %REPO% & exit /b 1)
call "%REPO%\start-worker.bat" %*
