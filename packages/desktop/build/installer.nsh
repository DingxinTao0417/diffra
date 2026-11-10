; 卸载时删掉 Diffra 浏览器扩展本机宿主的登记（Diffra 每次启动时写在当前用户下，见 src/main/native-host-registry.ts）。
; 升级时旧版的卸载程序也会跑，这时不删：新版启动后会重新登记
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\dev.diffra.browser"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\dev.diffra.browser"
  ${endIf}
!macroend
