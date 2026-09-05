@echo off
REM ---------------------------------------------------------------------------
REM Auto-update launcher for the AI Orchestrator worker node. TEMPLATE.
REM
REM Source of truth: scripts/windows/start-worker-autoupdate.template.bat
REM Deployed to:     %USERPROFILE%\.orchestrator\start-worker-autoupdate.bat
REM Deploy with:     scripts\windows\install-worker-launcher.ps1
REM The installer fills in the REPO value below.
REM
REM WHY THE DEPLOYED COPY LIVES OUTSIDE THE REPO
REM cmd.exe reads a .bat file incrementally from disk while executing it, seeking
REM by byte offset. If "git pull" rewrote this file mid-run, cmd would resume at a
REM stale offset in the new content and execute garbage. The file that performs
REM the pull therefore cannot itself be inside the tree being pulled.
REM
REM That is a reason to DEPLOY it elsewhere, not a reason to leave it UNTRACKED,
REM which is how this script drifted out of review and ran a worker with no
REM supervision for weeks (see docs/WORKER_AGENT_SETUP.md).
REM
REM Keep this file MINIMAL and STABLE. Anything that might need to change belongs
REM in start-worker.bat, which is called after the pull completes and is safe to
REM update in place.
REM
REM Keep this file pure ASCII: the installer writes it with ASCII encoding, so
REM smart quotes or dashes would be corrupted on write.
REM ---------------------------------------------------------------------------
setlocal
set "REPO=__REPO_PATH__"

REM Never block an unattended logon on an SSH/host-key or credential prompt.
set "GIT_TERMINAL_PROMPT=0"
set "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

cd /d "%REPO%" || (echo Repo not found: %REPO% & exit /b 1)

echo Pulling latest AI Orchestrator...
git pull --ff-only
if errorlevel 1 echo git pull failed or skipped - continuing with current code.

call "%REPO%\start-worker.bat" %*
