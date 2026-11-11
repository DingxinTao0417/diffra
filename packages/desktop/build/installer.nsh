; 卸载时删掉 Diffra 浏览器扩展本机宿主的登记（Diffra 每次启动时写在当前用户下，见 src/main/native-host-registry.ts）。
; 升级时旧版的卸载程序也会跑，这时不删：新版启动后会重新登记
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\dev.diffra.browser"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\dev.diffra.browser"
  ${endIf}
!macroend

; 浏览器扩展的本机宿主由 Chrome、Edge 经 %APPDATA%\Diffra\browser-bridge\diffra-browser-host.cmd 拉起，跑的是安装目录里的 Diffra.exe。
; 它不是 Diffra 的子进程，Diffra 退出时它不退；被结束后扩展 3 秒就重新拉起它。安装、卸载删旧文件时它占着 Diffra.exe，
; 卸载旧版就会失败（「Failed to uninstall old application files」，docs/decisions.md「发布与更新」）。
; 所以开始前先把启动脚本挪开（Diffra 每次启动都会重写它，新版一启动宿主就恢复），再结束还在跑的宿主：浏览器再拉起时找不到脚本，起不来
!macro stopBrowserHost
  Push $0
  ReadEnvStr $0 APPDATA
  StrCpy $0 "$0\${PRODUCT_NAME}\browser-bridge\diffra-browser-host.cmd"
  ; 升级时安装程序和旧版的卸载程序各跑一次：第二次脚本已经挪走了，不要把第一次挪出来的那份删掉
  ${If} ${FileExists} "$0"
    Delete "$0.updating"
    Rename "$0" "$0.updating"
  ${EndIf}
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "Get-CimInstance Win32_Process | ? { $$_.Name -eq '${APP_EXECUTABLE_FILENAME}' -and $$_.CommandLine -like '*native-host.js*' } | % { Stop-Process -Id $$_.ProcessId -Force }"`
  ; 第一个 Pop 取走 nsExec 的返回码（不管成败），第二个还原 $0
  Pop $0
  Pop $0
!macroend

; 安装程序：在结束运行中的 Diffra、卸载旧版之前
!macro customInit
  !insertmacro stopBrowserHost
!macroend

; 卸载程序：自己的进程检查在这之前，挪开脚本后再结束一次宿主（检查之后的这段时间里浏览器可能已经又拉起来了）
!macro customUnInit
  !insertmacro stopBrowserHost
!macroend
