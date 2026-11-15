import type { RichBlockKind } from '../../src/rich/blocks.js'

// 160×90 的示意截图（浅灰底、深色标题栏、中间一个按钮），给 annotate 的样例用
const SAMPLE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAAv0lEQVR42u3asREAEBREQRWpQSSWKULjgl+EGowIO/MquE0vldr0cMkEgAVYgAVYgAVYgAELsAALsADrCDhi6uEAAxZgARZgARZgAQYswAIswAIswAIMWIAFWIAFWIAFWIABC7AA75dHvy7AgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGCXHQEWYMACLMACLMACLMCABViABViABViAAQuwAAuwAAuwAAswYAEWYAEWYAEW4O9aYgFSn3wmhYgAAAAASUVORK5CYII='

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
  annotate: {
    valid: {
      title: '按钮被挡住了',
      image: `data:image/png;base64,${SAMPLE_PNG}`,
      size: [160, 90],
      marks: [
        { shape: 'box', x: 50, y: 40, w: 60, h: 18, note: '按钮在这里' },
        { shape: 'arrow', x: 20, y: 80, x2: 48, y2: 56, note: '点不到' },
        { shape: 'circle', x: 0, y: 0, w: 160, h: 14 },
        { shape: 'pin', x: 140, y: 70, note: '空白太多' },
      ],
    },
    invalid: '{"image":"https://example.com/a.png","marks":[{"shape":"pin","x":0.5,"y":0.5}]}',
  },
  decision: {
    valid: {
      title: '缓存放哪里',
      criteria: [{ name: '性能', weight: 3 }, { name: '改动量', weight: 2 }, '运维'],
      options: [
        { name: 'Redis', summary: '多实例共享', scores: { 性能: 5, 改动量: 2, 运维: 2 }, recommended: true },
        { name: '进程内缓存', summary: '改动最小', scores: { 性能: 4, 改动量: 5, 运维: 5 } },
      ],
    },
    invalid: '{"criteria":["性能"],"options":[{"name":"A","scores":{"性能":9}},{"name":"B","scores":{"性能":1}}]}',
  },
  depgraph: {
    valid: {
      title: '登录涉及的模块',
      focus: 'auth',
      nodes: [
        { id: 'ui', label: '登录页', path: 'src/pages/login.tsx' },
        { id: 'auth', label: 'auth', path: 'src/auth/index.ts:12', note: '校验密码、发令牌' },
        { id: 'db', label: '用户表', kind: 'database' },
        { id: 'sms', label: '短信服务', kind: 'external' },
        'cache',
      ],
      edges: [{ from: 'ui', to: 'auth', label: '提交' }, { from: 'auth', to: 'db', label: '读用户' }, ['auth', 'sms'], ['auth', 'cache']],
    },
    invalid: '{"nodes":["a"],"edges":[["a","b"]]}',
  },
  json: { valid: { name: 'diffra', scripts: { build: 'vite build' }, nested: { deep: { target: 'found-me' } } }, invalid: '{ 不是 JSON' },
  log: { valid: ['INFO 服务启动', 'WARN 慢查询 1200ms', 'ERROR 连接被拒绝', '    at connect (src/app.ts:3:5)'].join('\n'), invalid: null },
}

// 写进代码围栏里的原文
export function sampleSource(kind: RichBlockKind): string {
  const { valid } = RICH_SAMPLES[kind]
  return typeof valid === 'string' ? valid : JSON.stringify(valid, null, 2)
}
