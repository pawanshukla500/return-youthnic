; Return App Windows installer custom steps (wired via package.json "nsis.include").
; Runs with installer privileges (perMachine install is elevated).
;
; What this does on install:
;  1. Registers a Windows Scheduled Task "ReturnAppClaimBot" (logon trigger,
;     runs as the signing-in user so the visible supplier browser shows on
;     their desktop, restarts up to 3 times on failure). This is the recovery
;     path: reboot, crash, or missed auto-start all relaunch the bot hidden
;     into the tray. Single-instance lock in the app prevents doubles with
;     the in-app auto-start entry.
;  2. Warns (does not block) when no Chromium browser is found, because the
;     claim engine drives the installed Edge/Chrome/Chromium.
; On uninstall the scheduled task is removed. Supplier cookies and operator
; sign-in under %USERPROFILE%\.taskflow-claim-agent are intentionally kept so
; a reinstall or upgrade never forces every panel to sign in again.

!macro customInstall
  ; --- Browser presence check (warn only) ---
  StrCpy $0 ""
  ClearErrors
  IfFileExists "C:\Program Files\Microsoft\Edge\Application\msedge.exe" +3 0
  IfFileExists "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" +2 0
  StrCpy $0 "edge"
  ${If} $0 == ""
    IfFileExists "C:\Program Files\Google\Chrome\Application\chrome.exe" +3 0
    IfFileExists "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" +2 0
    StrCpy $0 "chrome"
  ${EndIf}
  ${If} $0 == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "Return App installed, but no Edge, Chrome, or Chromium browser was found.$\r$\n$\r$\nThe claim bot drives the system browser to file marketplace claims. Install Microsoft Edge or Google Chrome (or set the BROWSER_PATH environment variable), then use the dashboard's supplier-login setup."
  ${EndIf}

  ; --- Scheduled task XML (logon trigger + watchdog repetition + restart on failure) ---
  ; MultipleInstancesPolicy=IgnoreNew means a trigger that fires while the task is
  ; already running is ignored, so the 15-minute repetition below acts as a
  ; watchdog: if the app died for any reason (including a clean exit that
  ; RestartOnFailure would not catch), it is relaunched within 15 minutes and
  ; never duplicated. Duration PT0S repeats indefinitely.
  FileOpen $1 "$PLUGINSDIR\ReturnAppTask.xml" w
  FileWrite $1 '<?xml version="1.0" encoding="UTF-16"?>$\r$\n'
  FileWrite $1 '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">$\r$\n'
  FileWrite $1 '  <RegistrationInfo>$\r$\n'
  FileWrite $1 '    <Description>Return App 24/7 marketplace claim bot. Launches hidden into the tray and keeps filing panel-wise. Relaunched by the watchdog repetition if it stops.</Description>$\r$\n'
  FileWrite $1 '  </RegistrationInfo>$\r$\n'
  FileWrite $1 '  <Triggers>$\r$\n'
  FileWrite $1 '    <LogonTrigger>$\r$\n'
  FileWrite $1 '      <Enabled>true</Enabled>$\r$\n'
  FileWrite $1 '      <Repetition>$\r$\n'
  FileWrite $1 '        <Interval>PT15M</Interval>$\r$\n'
  FileWrite $1 '        <Duration>PT0S</Duration>$\r$\n'
  FileWrite $1 '        <StopAtDurationEnd>false</StopAtDurationEnd>$\r$\n'
  FileWrite $1 '      </Repetition>$\r$\n'
  FileWrite $1 '    </LogonTrigger>$\r$\n'
  FileWrite $1 '  </Triggers>$\r$\n'
  FileWrite $1 '  <Principals>$\r$\n'
  FileWrite $1 '    <Principal id="Author">$\r$\n'
  FileWrite $1 '      <LogonType>InteractiveToken</LogonType>$\r$\n'
  FileWrite $1 '      <RunLevel>LeastPrivilege</RunLevel>$\r$\n'
  FileWrite $1 '    </Principal>$\r$\n'
  FileWrite $1 '  </Principals>$\r$\n'
  FileWrite $1 '  <Settings>$\r$\n'
  FileWrite $1 '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>$\r$\n'
  FileWrite $1 '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>$\r$\n'
  FileWrite $1 '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>$\r$\n'
  FileWrite $1 '    <AllowHardTerminate>true</AllowHardTerminate>$\r$\n'
  FileWrite $1 '    <StartWhenAvailable>true</StartWhenAvailable>$\r$\n'
  FileWrite $1 '    <WakeToRun>false</WakeToRun>$\r$\n'
  FileWrite $1 '    <RestartOnFailure>$\r$\n'
  FileWrite $1 '      <Interval>PT1M</Interval>$\r$\n'
  FileWrite $1 '      <Count>999</Count>$\r$\n'
  FileWrite $1 '    </RestartOnFailure>$\r$\n'
  FileWrite $1 '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>$\r$\n'
  FileWrite $1 '  </Settings>$\r$\n'
  FileWrite $1 '  <Actions Context="Author">$\r$\n'
  FileWrite $1 '    <Exec>$\r$\n'
  FileWrite $1 '      <Command>"$INSTDIR\Return App.exe"</Command>$\r$\n'
  FileWrite $1 '      <Arguments>--hidden</Arguments>$\r$\n'
  FileWrite $1 '    </Exec>$\r$\n'
  FileWrite $1 '  </Actions>$\r$\n'
  FileWrite $1 '</Task>$\r$\n'
  FileClose $1
  ExecWait 'schtasks /create /TN "ReturnAppClaimBot" /XML "$PLUGINSDIR\ReturnAppTask.xml" /F'
  Delete "$PLUGINSDIR\ReturnAppTask.xml"
!macroend

!macro customUnInstall
  ExecWait 'schtasks /delete /TN "ReturnAppClaimBot" /F'
!macroend
