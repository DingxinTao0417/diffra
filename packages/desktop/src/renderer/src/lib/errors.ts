// ipcRenderer.invoke 的报错会带上 "Error invoking remote method 'x': Error: " 前缀，界面上去掉
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
