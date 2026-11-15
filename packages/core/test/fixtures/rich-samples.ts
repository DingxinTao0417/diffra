import type { RichBlockKind } from '../../src/rich/blocks.js'

// 每种内置富块的样例（第 684 步的质量门槛）：core 的 rich-gate.test.ts 和桌面端的 e2e/rich-gate.spec.ts 共用。
// 类型是 Record<RichBlockKind, …>：新加一种块却没给样例，类型检查就过不去。invalid 是数据不对的写法（log 是原文，没有不对的写法，为 null）
export const RICH_SAMPLES: Record<RichBlockKind, { valid: unknown; invalid: string | null }> = {
  chart: { valid: { type: 'bar', title: '构建耗时', unit: 's', data: [{ label: '安装', value: 12 }, { label: '构建', value: 30 }, { label: '测试', value: 45 }] }, invalid: '{"type":"bar","data":"不是数组"}' },
  metrics: { valid: { items: [{ label: '包体积', value: 412, unit: 'KB', delta: '-8%', better: 'down' }, { label: '用例', value: 130 }] }, invalid: '{"items":[{"value":1}]}' },
  table: { valid: { title: '模块体积', columns: ['模块', { key: 'kb', label: '体积（KB）' }], rows: [['app', 120], ['vendor', 340]] }, invalid: '{"columns":"模块","rows":[]}' },
  timeline: { valid: { items: [{ time: '10:00', title: '开始部署', status: 'done' }, { time: '10:05', title: '迁移数据库', status: 'failed', detail: '锁等待超时' }] }, invalid: '{"items":[{"time":"10:00"}]}' },
  steps: { valid: { title: '升级步骤', current: 2, items: ['备份数据', { title: '跑迁移', command: 'pnpm db:migrate' }, '重启服务'] }, invalid: '{"items":[]}' },
  compare: { valid: { criteria: ['速度'], options: [{ name: '方案 A', summary: '改动小', scores: { 速度: '一般' } }, { name: '方案 B', summary: '重写缓存', scores: { 速度: '快' }, recommended: true }] }, invalid: '{"options":[{"summary":"没有名字"}]}' },
  filetree: { valid: { items: [{ path: 'src/app.ts', status: 'modified' }, { path: 'src/new.ts', status: 'added', note: '新的入口' }] }, invalid: '{"items":[{"status":"added"}]}' },
  keyvalue: { valid: { 端口: 3000, 模式: 'development', 入口: 'src/app.ts' }, invalid: '["不是对象"]' },
  todos: { valid: { items: ['补上解析器的测试', { text: '换掉过期的密钥', note: '下周前' }] }, invalid: '{"items":[{"note":"没有内容"}]}' },
  json: { valid: { name: 'diffra', scripts: { build: 'vite build' }, nested: { deep: { target: 'found-me' } } }, invalid: '{ 不是 JSON' },
  log: { valid: ['INFO 服务启动', 'WARN 慢查询 1200ms', 'ERROR 连接被拒绝', '    at connect (src/app.ts:3:5)'].join('\n'), invalid: null },
}

// 写进代码围栏里的原文
export function sampleSource(kind: RichBlockKind): string {
  const { valid } = RICH_SAMPLES[kind]
  return typeof valid === 'string' ? valid : JSON.stringify(valid, null, 2)
}
