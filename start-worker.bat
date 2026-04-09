@echo off
cd /d "%~dp0"

echo Building worker agent...
call npx tsx build-worker-agent.ts
if errorlevel 1 (
    echo Build failed.
    exit /b 1
)

echo Starting worker agent...
node dist/worker-agent/index.js %*
