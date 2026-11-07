import { useEffect, useRef, useState } from 'react'
import type { McpServerStatus } from '@diffra/core/types'
import type { McpStatusTarget } from '../../../../shared/ipc'
import { errorMessage } from '@/lib/errors'

// MCP 服务器的状态；target 为 null 时不查。version 变了重新查，retry() 让连不上的马上重连
export function useMcpStatus(target: McpStatusTarget | null, version = 0) {
  const [state, setState] = useState<{ statuses: McpServerStatus[] | null; loading: boolean; error: string | null }>({
    statuses: null,
    loading: false,
    error: null,
  })
  const [retries, setRetries] = useState(0)
  const retrying = useRef(false)
  const key = target ? JSON.stringify(target) : null

  useEffect(() => {
    if (key === null) return
    let stale = false
    const retry = retrying.current
    retrying.current = false
    setState((current) => ({ ...current, loading: true }))
    window.diffra.mcpStatus(JSON.parse(key) as McpStatusTarget, retry).then(
      (statuses) => !stale && setState({ statuses, loading: false, error: null }),
      (error: unknown) => {
        console.error('读取 MCP 状态失败', error)
        if (!stale) setState((current) => ({ ...current, loading: false, error: errorMessage(error) }))
      },
    )
    return () => {
      stale = true
    }
  }, [key, version, retries])

  return {
    ...state,
    retry: () => {
      retrying.current = true
      setRetries((count) => count + 1)
    },
  }
}
