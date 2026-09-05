' ---------------------------------------------------------------------------
' Hidden, BLOCKING launcher for the AI Orchestrator worker node. TEMPLATE.
'
' Source of truth: scripts/windows/run-worker-hidden.template.vbs
' Deployed to:     %USERPROFILE%\.orchestrator\run-worker-hidden.vbs
' Deploy with:     scripts\windows\install-worker-launcher.ps1
' The installer fills in the launcher path below.
'
' The third Run() argument (bWaitOnReturn) is True ON PURPOSE, and it is the
' whole point of this file.
'
' The previous setup launched the worker with "cmd /c start ... /min", which
' DETACHES. Task Scheduler then saw its action finish in milliseconds, marked the
' task succeeded, and never learned the worker had died. That made its
' RestartOnFailure setting inert, and left LastRunTime weeks in the past while
' the node was down.
'
' Blocking here means the task stays in the Running state for as long as the
' worker lives, so Task Scheduler tracks real liveness and the repetition trigger
' in install-worker-launcher.ps1 can actually bring it back.
'
' Window style 0 keeps it off screen.
'
' Keep this file pure ASCII: the installer writes it with ASCII encoding, so
' smart quotes or dashes would be corrupted on write.
' ---------------------------------------------------------------------------
Option Explicit

Dim shell, launcher, quote, command, exitCode
Set shell = CreateObject("WScript.Shell")

launcher = "__LAUNCHER_PATH__"

' Build: cmd.exe /c ""C:\path with spaces\start-worker-autoupdate.bat""
' The doubled quotes are the documented cmd /c idiom: cmd strips the outer pair,
' leaving the path correctly quoted. Chr(34) is used instead of escaped literals
' because counting six consecutive quote characters is how this gets broken.
quote = Chr(34)
command = "cmd.exe /c " & quote & quote & launcher & quote & quote

' 0 = hidden window, True = wait for the worker to exit before returning.
exitCode = shell.Run(command, 0, True)

WScript.Quit exitCode
