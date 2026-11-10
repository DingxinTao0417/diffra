import { useEffect, useState } from 'react'
import { type ChangelogRelease, compareVersions } from '../../../../shared/changelog'
import type { UpdateNotice } from '../../../../shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { openSettings } from '@/state/actions'

// 一个版本的新增和修复
export function ReleaseItems({ added, fixed }: { added: string[]; fixed: string[] }) {
  return (
    <div className="space-y-2 text-sm">
      {[
        { title: '新增', items: added },
        { title: '修复', items: fixed },
      ]
        .filter((section) => section.items.length > 0)
        .map((section) => (
          <div key={section.title}>
            <div className="text-xs text-muted-foreground">{section.title}</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  )
}

export function ReleaseList({ releases, current }: { releases: ChangelogRelease[]; current: string | null }) {
  return (
    <div className="divide-y" data-testid="changelog">
      {releases.map((release) => (
        <section key={release.version} className="px-4 py-3" aria-label={`版本 ${release.version}`}>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold tabular-nums">
            {release.version}
            <span className="font-normal text-muted-foreground">{release.date}</span>
            {release.version === current && <Badge variant="secondary">当前</Badge>}
          </h3>
          <ReleaseItems added={release.added} fixed={release.fixed} />
        </section>
      ))}
    </div>
  )
}

// 升级后第一次启动：列出这次升级带来的版本（从上次用的版本之后到现在）；不知道从哪升上来的就只列当前版本
export function UpdateNoticeDialog() {
  const [notice, setNotice] = useState<UpdateNotice | null>(null)
  const [releases, setReleases] = useState<ChangelogRelease[]>([])
  useEffect(() => {
    void (async () => {
      const taken = await window.diffra.takeUpdateNotice()
      if (!taken) return
      const all = await window.diffra.getChangelog()
      setReleases(all.filter((release) => compareVersions(release.version, taken.to) <= 0 && (taken.from === null ? release.version === taken.to : compareVersions(release.version, taken.from) > 0)))
      setNotice(taken)
    })().catch((error: unknown) => console.error('[changelog] 读取更新提示失败', error))
  }, [])
  if (!notice) return null
  const close = () => setNotice(null)
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg" data-testid="update-notice">
        <DialogHeader>
          <DialogTitle>已更新到 {notice.to}</DialogTitle>
          <DialogDescription>{releases.length > 0 ? '这次更新带来了这些改动。' : '这个版本没有附带更新日志。'}</DialogDescription>
        </DialogHeader>
        {releases.length > 0 && (
          <DialogBody className="max-h-[60vh] space-y-4">
            {releases.map((release) => (
              <section key={release.version} aria-label={`版本 ${release.version}`}>
                {releases.length > 1 && <h3 className="mb-1 text-sm font-semibold tabular-nums">{release.version}</h3>}
                <ReleaseItems added={release.added} fixed={release.fixed} />
              </section>
            ))}
          </DialogBody>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              close()
              openSettings('about')
            }}
          >
            查看全部更新日志
          </Button>
          <Button onClick={close}>知道了</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
