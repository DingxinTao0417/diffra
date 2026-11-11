import { useEffect, useMemo } from 'react'
import type { SessionList } from '@diffra/remote/messages'
import { useAppState } from '@/state/store'
import { loadRemoteList } from './remote-tasks'

export interface RemoteProjectGroup {
  // 和本机项目共用侧栏的折叠状态，键前面带上 remote: 和设备，不会和本机路径撞
  key: string
  deviceId: string
  deviceName: string
  online: boolean
  name: string
  sessions: SessionList['sessions']
}

// 选择器要返回同一个引用，否则 useSyncExternalStore 认为每次都变了，无限重渲染
const NO_PEERS: never[] = []

// 侧栏「项目」里别的设备授权给本机看的项目：在线的设备取一次列表，对方重新上线时再取。
// 列表只在内存里，对方离线时还显示上次取到的；本次启动以来一直没在线过的设备，它的项目不显示
export function useRemoteProjects(): RemoteProjectGroup[] {
  const peers = useAppState((state) => state.remote?.peers ?? NO_PEERS)
  const lists = useAppState((state) => state.remoteLists)
  const online = peers
    .filter((peer) => peer.online)
    .map((peer) => peer.deviceId)
    .join(',')
  useEffect(() => {
    for (const deviceId of online.split(',').filter(Boolean)) void loadRemoteList(deviceId)
  }, [online])

  return useMemo(
    () =>
      peers
        .flatMap((peer) => {
          const list = lists[peer.deviceId]?.list
          if (!list) return []
          return list.projects.map((project) => ({
            key: `remote:${peer.deviceId}/${project.id}`,
            deviceId: peer.deviceId,
            deviceName: peer.name,
            online: peer.online,
            name: project.name,
            sessions: list.sessions.filter((session) => session.projectId === project.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          }))
        })
        .sort((a, b) => (b.sessions[0]?.updatedAt ?? '').localeCompare(a.sessions[0]?.updatedAt ?? '')),
    [peers, lists],
  )
}
