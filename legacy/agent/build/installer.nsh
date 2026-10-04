; Custom NSIS install/uninstall steps for the Timo agent.
; electron-builder auto-includes build/installer.nsh (app-builder-lib
; installSection.nsh does `!include installer.nsh` + `!insertmacro customInstall`;
; uninstaller.nsh does `!insertmacro customUnInstall`).
;
; Why this file exists: electron-builder's `protocols:` config only writes the
; URL scheme into the macOS Info.plist — the NSIS target registers NOTHING. So
; on Windows the timo:// deep link that finishes Lark login has no OS handler
; unless we write it here at install time (the runtime setAsDefaultProtocolClient
; call is a fragile, easily-stale backstop). We also delete the pre-rebrand
; grind:// association so the browser can't route the old scheme to a dead app.

!macro customInstall
  DeleteRegKey HKCU "Software\Classes\timo"
  WriteRegStr HKCU "Software\Classes\timo" "" "URL:timo Protocol"
  WriteRegStr HKCU "Software\Classes\timo" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\timo\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\timo\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; Remove the pre-Timo scheme so a stale handler can't intercept logins.
  DeleteRegKey HKCU "Software\Classes\grind"

  ; Remove startup entries from pre-rebrand and accidental package-name builds.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Timo"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Timo time tracker desktop agent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Grind"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "@grind/agent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Timo"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Timo time tracker desktop agent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Grind"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "@grind/agent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32" "Timo"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32" "Timo time tracker desktop agent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32" "Grind"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32" "@grind/agent"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\timo"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Timo"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Timo time tracker desktop agent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Grind"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "@grind/agent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Timo"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Timo time tracker desktop agent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Grind"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "@grind/agent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32" "Timo"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32" "Timo time tracker desktop agent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32" "Grind"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32" "@grind/agent"
!macroend
