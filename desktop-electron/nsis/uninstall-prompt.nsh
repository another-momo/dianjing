; 卸载用户数据可选化（2026-09-17 owner 拍板）：electron-builder 的
; deleteAppDataOnUninstall 是无条件静默删 %APPDATA%\Dianjing，改为卸载段
; 开头弹问——默认「否」保留；静默卸载（/S，/SD IDNO 兜底）与升级卸载
; （--updated）一律保留。
; 状态根已统一进 %APPDATA%\Dianjing（D2）：pi-agent 凭据 / pi-sessions 会话 /
; studio 用户拓展 / workspace 全在其中，误删代价高。
; 编码纪律：本文件必须 UTF-8 with BOM——makensis 缺省按系统 ANSI 读无 BOM
; 脚本，中文文案会变乱码（改本文件后 BOM 丢了即事故）。
!macro customUnInstall
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONQUESTION "是否同时删除 Dianjing 用户数据？$\r$\n$\r$\n包含：AI 会话记录、API 凭据、自定义拓展（studio）、工作区文件。$\r$\n选「否」保留——重装后可继续使用。" /SD IDNO IDYES dianjing_del_userdata
    Goto dianjing_keep_userdata
    dianjing_del_userdata:
      RMDir /r "$APPDATA\${APP_FILENAME}"
    dianjing_keep_userdata:
  ${EndIf}
!macroend
