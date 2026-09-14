; shell-polish B2: Uninstaller hook for %USERPROFILE%\.dianjing\studio\.
;
; electron-builder 26 templates/nsis/uninstaller.nsh L156 calls
; `!insertmacro customUnInstall` if defined -- this file provides that macro.
; deleteAppDataOnUninstall (set in electron-builder.yml) only removes %APPDATA%
; userData via APP_FILENAME / APP_PRODUCT_FILENAME / APP_PACKAGE_NAME keys, but
; the user-customized studio directory sits under %USERPROFILE% (Windows: $PROFILE
; in NSIS), outside that scope. Recursive RMDir /r clears the whole tree; if it
; does not exist RMDir is a no-op so safe to run unconditionally.
;
; Pure ASCII per AGENTS.md CJK byte-safety rule -- this file is consumed by
; makensis which historically treats UTF-8 BOMs as text; any non-ASCII byte
; risks being interpreted as part of an installer file path by older makensis
; builds, hence ASCII-only.

!macro customUnInstall
  RMDir /r "$PROFILE\.dianjing\studio"
!macroend