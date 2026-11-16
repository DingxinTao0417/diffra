import { useEffect, useState } from 'react'
import type { UsagePrice, UsageSummary } from '@diffra/core/types'
import { DEFAULT_USAGE, type UsageSettings } from '../../../../shared/settings'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { errorMessage } from '@/lib/errors'
import { showToast, store, useAppState } from '@/state/store'
import { checkUsageBudget } from '@/state/usage-budget'

const PRICE = /^\d{1,7}(\.\d{1,6})?$/
type PriceDraft = { providerId: string | null; providerName: string | null; modelId: string; input: string; cachedInput: string; cacheWrite: string; output: string }

const keyOf = (item: { providerId: string | null; modelId: string }) => `${item.providerId ?? ''}\u0000${item.modelId}`

// 单价和预算（v2 · M11）：列出这段时间用过的模型和已经填过单价的模型，每百万 token 多少钱；输入价和输出价都填了才算这个模型的费用
export function UsagePricesDialog({ open, models, onClose, onSaved }: { open: boolean; models: UsageSummary['models']; onClose(): void; onSaved(): void }) {
  const usage = useAppState((state) => state.settings?.usage ?? DEFAULT_USAGE)
  const [currency, setCurrency] = useState<UsageSettings['currency']>(usage.currency)
  const [budget, setBudget] = useState(usage.monthlyBudget ?? '')
  const [rows, setRows] = useState<PriceDraft[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setCurrency(usage.currency)
    setBudget(usage.monthlyBudget ?? '')
    setError(null)
    const known = new Map(usage.prices.map((price) => [keyOf(price), price]))
    const drafts = new Map<string, PriceDraft>()
    for (const model of models) {
      const price = known.get(keyOf(model))
      drafts.set(keyOf(model), { providerId: model.providerId, providerName: model.providerName, modelId: model.modelId, input: price?.input ?? '', cachedInput: price?.cachedInput ?? '', cacheWrite: price?.cacheWrite ?? '', output: price?.output ?? '' })
    }
    for (const price of usage.prices) if (!drafts.has(keyOf(price))) drafts.set(keyOf(price), { ...price, providerName: null, cachedInput: price.cachedInput ?? '', cacheWrite: price.cacheWrite ?? '' })
    setRows([...drafts.values()])
  }, [open, usage, models])

  const update = (index: number, field: 'input' | 'cachedInput' | 'cacheWrite' | 'output', value: string) => setRows((current) => current.map((row, at) => (at === index ? { ...row, [field]: value.trim() } : row)))

  const save = async () => {
    const prices: UsagePrice[] = []
    for (const row of rows) {
      if (!row.input && !row.output) continue
      const fields = [row.input, row.output, row.cachedInput, row.cacheWrite].filter(Boolean)
      if (!row.input || !row.output || fields.some((value) => !PRICE.test(value))) {
        setError(`「${row.modelId}」的单价要填数字（最多 6 位小数），输入价和输出价都要填`)
        return
      }
      prices.push({ providerId: row.providerId, modelId: row.modelId, input: row.input, output: row.output, cachedInput: row.cachedInput || null, cacheWrite: row.cacheWrite || null })
    }
    if (budget && !PRICE.test(budget.trim())) {
      setError('每月预算要填数字')
      return
    }
    try {
      const next: UsageSettings = { currency, prices, monthlyBudget: budget.trim() || null, budgetNotice: budget.trim() === (usage.monthlyBudget ?? '') ? usage.budgetNotice : null }
      const settings = await window.diffra.savePreferences({ usage: next })
      store.set((state) => ({ ...state, settings }))
      onSaved()
      onClose()
      void checkUsageBudget(true)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="sm:max-w-3xl" data-testid="usage-prices">
        <DialogHeader>
          <DialogTitle>单价和预算</DialogTitle>
          <DialogDescription>按供应商官网的价格填每百万 token 多少钱；缓存命中、写入缓存没填时按输入价算。费用按供应商返回的用量算，只是估算，以账单为准。</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented<UsageSettings['currency']>
              label="币种"
              size="sm"
              value={currency}
              options={[
                { value: 'CNY', label: '人民币' },
                { value: 'USD', label: '美元' },
              ]}
              onChange={setCurrency}
            />
            <Label htmlFor="usage-budget" className="ml-auto">
              每月预算
            </Label>
            <Input id="usage-budget" className="h-8 w-32 text-right tabular-nums" inputMode="decimal" placeholder="不设" value={budget} onChange={(event) => setBudget(event.target.value)} />
          </div>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">这段时间还没有用过模型。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-xl text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 text-left font-normal">模型</th>
                    <th className="w-24 px-1 text-right font-normal">输入</th>
                    <th className="w-24 px-1 text-right font-normal">缓存命中</th>
                    <th className="w-24 px-1 text-right font-normal">写入缓存</th>
                    <th className="w-24 px-1 text-right font-normal">输出</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={keyOf(row)} data-testid="usage-price-row">
                      <td className="max-w-0 truncate py-1 pr-2" title={row.modelId}>
                        {row.providerName ? <span className="text-muted-foreground">{row.providerName} / </span> : null}
                        {row.modelId}
                      </td>
                      {(['input', 'cachedInput', 'cacheWrite', 'output'] as const).map((field) => (
                        <td key={field} className="px-1 py-1">
                          <Input
                            aria-label={`${row.modelId} 的${{ input: '输入', cachedInput: '缓存命中', cacheWrite: '写入缓存', output: '输出' }[field]}单价`}
                            className="h-8 text-right tabular-nums"
                            inputMode="decimal"
                            placeholder={field === 'input' || field === 'output' ? '' : '同输入'}
                            value={row[field]}
                            onChange={(event) => update(index, field, event.target.value)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void save()}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const formatBytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

// 清理旧记录（v2 · M11）：按月份删记录文件，删了就没了（统计里也看不到那几个月），先确认
export function UsageCleanupDialog({ open, onClose, onDone }: { open: boolean; onClose(): void; onDone(): void }) {
  const [files, setFiles] = useState<Array<{ month: string; bytes: number }> | null>(null)
  const [before, setBefore] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setFiles(null)
    setBefore(null)
    window.diffra
      .usageFiles()
      .then(setFiles)
      .catch((error: unknown) => showToast(`读取用量记录失败：${errorMessage(error)}`))
  }, [open])

  const removed = files && before ? files.filter((file) => file.month < before) : []
  const cleanup = async () => {
    if (!before) return
    try {
      const result = await window.diffra.cleanupUsage(before)
      showToast(`删掉了 ${result.removed.length} 个月的用量记录`)
      onDone()
    } catch (error) {
      showToast(`清理失败：${errorMessage(error)}`)
    }
    onClose()
  }

  return (
    <AlertDialog open={open} onOpenChange={(value) => !value && onClose()}>
      <AlertDialogContent data-testid="usage-cleanup">
        <AlertDialogHeader>
          <AlertDialogTitle>清理旧的用量记录</AlertDialogTitle>
          <AlertDialogDescription>记录按月存（UTC 月份）。选一个月份，删掉它之前的所有月份；删了统计里就看不到这些月了，不能恢复。要留底先「导出」。</AlertDialogDescription>
        </AlertDialogHeader>
        {files === null ? (
          <p className="text-sm text-muted-foreground">正在读取…</p>
        ) : files.length <= 1 ? (
          <p className="text-sm text-muted-foreground">只有{files.length === 1 ? '一个月' : '零个月'}的记录，没什么可清理的。</p>
        ) : (
          <div className="space-y-2">
            <Segmented<string>
              label="保留从哪个月开始"
              size="sm"
              value={before ?? ''}
              options={files.slice(1).map((file) => ({ value: file.month, label: `从 ${file.month} 起` }))}
              onChange={setBefore}
            />
            <p className="text-xs text-muted-foreground" data-testid="usage-cleanup-preview">
              {before ? `会删掉 ${removed.map((file) => file.month).join('、')}，共 ${formatBytes(removed.reduce((sum, file) => sum + file.bytes, 0))}` : `一共 ${files.length} 个月，${formatBytes(files.reduce((sum, file) => sum + file.bytes, 0))}`}
            </p>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction disabled={!before} onClick={() => void cleanup()}>
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
