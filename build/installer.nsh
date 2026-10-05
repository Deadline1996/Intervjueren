; Intervjueren installer additions (picked up automatically by electron-builder).
; Adds a page with checkboxes for Start menu entry, desktop shortcut and autostart, and creates
; or removes those based on the choices. electron-builder's own shortcut creation is turned off
; in package.json so these checkboxes are the only source of truth.

!include nsDialogs.nsh

!define AUTOSTART_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define AUTOSTART_NAME "Intervjueren"
!define START_MENU_LINK "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
!define DESKTOP_LINK "$DESKTOP\${SHORTCUT_NAME}.lnk"

; Declared here rather than in customHeader: electron-builder builds the pages before it inserts
; customHeader, so the page code would reference variables that don't exist yet.
!ifndef BUILD_UNINSTALLER
  Var optStartMenu
  Var optDesktop
  Var optAutostart
  Var chkStartMenu
  Var chkDesktop
  Var chkAutostart
!endif

; Always install for the current user only (no admin rights needed), so skip the
; "for me / for all users" page.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Defaults, also used for silent installs (/S) where the page is never shown.
!macro customInit
  !ifndef BUILD_UNINSTALLER
    StrCpy $optStartMenu ${BST_CHECKED}
    StrCpy $optDesktop ${BST_CHECKED}
    StrCpy $optAutostart ${BST_UNCHECKED}
  !endif
!macroend

!macro customPageAfterChangeDir
  !ifndef BUILD_UNINSTALLER
  Page custom ShortcutsPageShow ShortcutsPageLeave

  Function ShortcutsPageShow
    !insertmacro MUI_HEADER_TEXT "Snarveier og oppstart" "Velg hvordan du vil åpne Intervjueren."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateCheckbox} 0 0 100% 12u "Legg til i Start-menyen"
    Pop $chkStartMenu
    ${NSD_SetState} $chkStartMenu $optStartMenu

    ${NSD_CreateCheckbox} 0 20u 100% 12u "Lag snarvei på skrivebordet"
    Pop $chkDesktop
    ${NSD_SetState} $chkDesktop $optDesktop

    ${NSD_CreateCheckbox} 0 40u 100% 12u "Start Intervjueren når Windows starter (venter i systemstatusfeltet)"
    Pop $chkAutostart
    ${NSD_SetState} $chkAutostart $optAutostart

    ${NSD_CreateLabel} 0 72u 100% 40u "Tips: Windows lar ikke installasjonsprogrammer feste apper til Start eller oppgavelinjen. Vil du ha Intervjueren der, høyreklikker du den i Start-menyen og velger «Fest til Start» eller «Fest til oppgavelinjen»."
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function ShortcutsPageLeave
    ${NSD_GetState} $chkStartMenu $optStartMenu
    ${NSD_GetState} $chkDesktop $optDesktop
    ${NSD_GetState} $chkAutostart $optAutostart
  FunctionEnd
  !endif
!macroend

!macro customInstall
  ${If} $optStartMenu == ${BST_CHECKED}
    CreateShortCut "${START_MENU_LINK}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "${START_MENU_LINK}" "${APP_ID}"
  ${Else}
    Delete "${START_MENU_LINK}"
  ${EndIf}

  ${If} $optDesktop == ${BST_CHECKED}
    CreateShortCut "${DESKTOP_LINK}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "${DESKTOP_LINK}" "${APP_ID}"
  ${Else}
    Delete "${DESKTOP_LINK}"
  ${EndIf}

  ${If} $optAutostart == ${BST_CHECKED}
    WriteRegStr HKCU "${AUTOSTART_KEY}" "${AUTOSTART_NAME}" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hidden'
  ${Else}
    DeleteRegValue HKCU "${AUTOSTART_KEY}" "${AUTOSTART_NAME}"
  ${EndIf}
!macroend

; Recordings and settings are left alone; only what the installer created is removed.
; (When upgrading, the old version is uninstalled with --updated: keep everything then.)
!macro customUnInstall
  ${IfNot} ${isUpdated}
    Delete "${START_MENU_LINK}"
    Delete "${DESKTOP_LINK}"
    DeleteRegValue HKCU "${AUTOSTART_KEY}" "${AUTOSTART_NAME}"
  ${EndIf}
!macroend
