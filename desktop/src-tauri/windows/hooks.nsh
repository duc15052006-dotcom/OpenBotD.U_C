; OpenBot's Windows installer promises a desktop shortcut, not merely a Start-menu entry.
; Keep this as a hook rather than a forked Tauri installer template so future Tauri installer
; security fixes still apply.
;
; `$DESKTOP` resolves for the account actually running the installer. That matters because the
; release acceptance deliberately installs as a Users-only account and should leave the shortcut
; on that person's desktop rather than an administrator's.

!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$DESKTOP\OpenBot.lnk" "$INSTDIR\openbot-desktop.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$DESKTOP\OpenBot.lnk"
!macroend
