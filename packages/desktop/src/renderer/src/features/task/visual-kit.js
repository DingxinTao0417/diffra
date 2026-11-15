// 可视化工具箱（第 666 步）：以文字形式注入 show_visual 的沙箱 iframe（VisualCard 的 visualDocument），模型写的代码一开始就能用。
// diffra.chart 画主题色的 SVG 图表，diffra.ui 是几种小组件，diffra.openFile / openBrowser / copy / ask 走主界面的白名单。
// 颜色只用主题变量（--fg、--muted、--border、--card、--chart-1..4 等），跟着应用的深浅色和配色走。
// 这里是普通 JS，跑在 iframe 里，不依赖主界面的任何代码
;(function () {
  var diffra = window.diffra || (window.diffra = {})
  var send = function (message) {
    parent.postMessage(message, '*')
  }

  var style = document.createElement('style')
  style.textContent = [
    '.dk-card{border:1px solid var(--border);border-radius:10px;background:var(--card);padding:12px 14px;display:flex;flex-direction:column;gap:6px}',
    '.dk-card-title{font-weight:700}',
    '.dk-card-footer{color:var(--muted);font-size:12px}',
    '.dk-tone-warning{border-color:color-mix(in oklab,var(--warning) 30%,transparent);background:color-mix(in oklab,var(--warning) 8%,var(--card))}',
    '.dk-tone-danger{border-color:color-mix(in oklab,var(--danger) 30%,transparent);background:color-mix(in oklab,var(--danger) 8%,var(--card))}',
    '.dk-tone-accent{border-color:color-mix(in oklab,var(--primary) 40%,transparent)}',
    '.dk-stat{border:1px solid var(--border);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.dk-stat-label{color:var(--muted);font-size:12px}',
    '.dk-stat-value{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}',
    '.dk-stat-unit{color:var(--muted);font-size:12px;margin-left:3px;font-weight:400}',
    '.dk-stat-delta{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}',
    '.dk-stat-delta.dk-worse{color:var(--warning)}',
    '.dk-badge{display:inline-flex;align-items:center;border-radius:4px;padding:0 6px;font-size:12px;line-height:18px;border:1px solid var(--border);color:var(--muted)}',
    '.dk-badge.dk-tone-warning{color:var(--warning)}.dk-badge.dk-tone-danger{color:var(--danger)}.dk-badge.dk-tone-success{color:var(--success);border-color:color-mix(in oklab,var(--success) 40%,transparent)}.dk-badge.dk-tone-accent{color:var(--primary)}',
    '.dk-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(var(--dk-min,160px),1fr))}',
    '.dk-tabs-list{display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:8px}',
    '.dk-tab{all:unset;cursor:pointer;padding:4px 10px;border-radius:6px 6px 0 0;color:var(--muted)}',
    '.dk-tab[aria-selected=true]{color:var(--fg);background:var(--soft)}',
    '.dk-tab:focus-visible{outline:2px solid var(--primary);outline-offset:-2px}',
    '.dk-progress{display:flex;flex-direction:column;gap:4px}',
    '.dk-progress-row{display:flex;justify-content:space-between;font-size:12px;color:var(--muted)}',
    '.dk-progress-track{height:6px;border-radius:999px;background:var(--accent);overflow:hidden}',
    '.dk-progress-fill{height:100%;border-radius:999px;background:var(--chart-1)}',
    '.dk-table{border-collapse:separate;border-spacing:0;width:100%;border:1px solid var(--border);border-radius:8px;overflow:hidden;font-size:13px}',
    '.dk-table th{background:var(--accent);text-align:left;font-weight:700}',
    '.dk-table th,.dk-table td{padding:5px 10px;border-bottom:1px solid var(--border)}',
    '.dk-table tr:last-child td{border-bottom:none}',
    '.dk-num{text-align:right;font-variant-numeric:tabular-nums}',
    '.dk-chart{display:flex;flex-direction:column;gap:6px}',
    '.dk-chart-title{font-weight:700}',
    '.dk-chart svg{width:100%;height:auto;display:block;overflow:visible}',
    '.dk-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--muted)}',
    '.dk-legend button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px}',
    '.dk-legend button[aria-pressed=false]{opacity:.45;text-decoration:line-through}',
    '.dk-legend i{width:10px;height:10px;border-radius:2px;display:inline-block}',
    '[data-step].dk-hidden{visibility:hidden}',
  ].join('\n')
  document.head.appendChild(style)

  var SVG = 'http://www.w3.org/2000/svg'
  function svg(tag, attrs, parent) {
    var node = document.createElementNS(SVG, tag)
    for (var key in attrs) if (attrs[key] !== undefined && attrs[key] !== null) node.setAttribute(key, String(attrs[key]))
    if (parent) parent.appendChild(node)
    return node
  }
  function el(tag, className, children) {
    var node = document.createElement(tag)
    if (className) node.className = className
    append(node, children)
    return node
  }
  // 子内容：字符串按文字放（不当 HTML），节点原样放，数组逐个放
  function append(node, children) {
    if (children === undefined || children === null || children === false) return
    if (Array.isArray(children)) return children.forEach(function (child) { append(node, child) })
    node.appendChild(children instanceof Node ? children : document.createTextNode(String(children)))
  }
  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  }
  function palette() {
    var base = ['--chart-1', '--chart-2', '--chart-3', '--chart-4'].map(token).filter(Boolean)
    return base.length ? base : ['currentColor']
  }
  var compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
  var plain = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
  function format(value, unit) {
    if (typeof value !== 'number' || !isFinite(value)) return '—'
    return (Math.abs(value) >= 10000 ? compact.format(value) : plain.format(value)) + (unit || '')
  }
  // 坐标轴的刻度：取 1、2、5 乘 10 的幂，约 count 格
  function ticks(min, max, count) {
    if (min === max) max = min + 1
    var raw = (max - min) / count
    var power = Math.pow(10, Math.floor(Math.log10(raw)))
    var step = [1, 2, 5, 10].map(function (m) { return m * power }).find(function (s) { return s >= raw })
    var start = Math.floor(min / step) * step
    var result = []
    for (var value = start; value <= max + step * 0.5; value += step) result.push(Math.round(value * 1e9) / 1e9)
    return result
  }

  // 数据统一成 { labels, series: [{ name, values }] }；散点的 values 是 [x, y]
  function normalize(type, data) {
    if (Array.isArray(data)) {
      if (type === 'scatter') return { labels: [], series: [{ name: '', values: data.map(function (p) { return Array.isArray(p) ? p : [p.x, p.y] }) }] }
      return { labels: data.map(function (d, i) { return String(d.label !== undefined ? d.label : d.name !== undefined ? d.name : i + 1) }), series: [{ name: '', values: data.map(function (d) { return typeof d === 'number' ? d : d.value }) }] }
    }
    var series = (data.series || []).map(function (s) { return { name: String(s.name || ''), values: (s.values || s.data || []).slice() } })
    return { labels: (data.labels || data.x || []).map(String), series: series }
  }

  // diffra.chart(type, data, options)：type 是 bar、line、area、pie、donut、scatter；data 见 normalize。
  // options：title、unit、height、stacked、into（选择器或节点，画进去）。返回外层节点；点图例切换系列
  diffra.chart = function (type, data, options) {
    options = options || {}
    var model = normalize(type, data)
    var hidden = {}
    var wrap = el('div', 'dk-chart')
    wrap.setAttribute('role', 'img')
    wrap.setAttribute('aria-label', (options.title || '图表') + '：' + model.series.map(function (s) { return (s.name ? s.name + ' ' : '') + s.values.map(function (v, i) { return (model.labels[i] || '') + ' ' + (Array.isArray(v) ? v.join(',') : v) }).join('，') }).join('；'))
    if (options.title) wrap.appendChild(el('div', 'dk-chart-title', options.title))
    var holder = el('div')
    wrap.appendChild(holder)
    var draw = function () {
      holder.textContent = ''
      holder.appendChild(type === 'pie' || type === 'donut' ? pie(model, options, type === 'donut', hidden) : type === 'scatter' ? scatter(model, options, hidden) : cartesian(type, model, options, hidden))
    }
    draw()
    var colors = palette()
    var names = type === 'pie' || type === 'donut' ? model.labels : model.series.map(function (s) { return s.name })
    if (names.length > 1 && names.some(Boolean)) {
      var legend = el('div', 'dk-legend')
      names.forEach(function (name, index) {
        var button = el('button', '', [el('i'), name || '系列 ' + (index + 1)])
        button.firstChild.style.background = colors[index % colors.length]
        button.setAttribute('aria-pressed', 'true')
        button.onclick = function () {
          hidden[index] = !hidden[index]
          button.setAttribute('aria-pressed', String(!hidden[index]))
          draw()
        }
        legend.appendChild(button)
      })
      wrap.appendChild(legend)
    }
    if (options.into) (typeof options.into === 'string' ? document.querySelector(options.into) : options.into).appendChild(wrap)
    return wrap
  }

  var W = 640
  function frame(height) {
    var root = svg('svg', { viewBox: '0 0 ' + W + ' ' + height, 'font-size': 12, 'font-family': 'inherit' })
    return root
  }
  function axisText(parent, x, y, text, anchor) {
    var node = svg('text', { x: x, y: y, fill: 'var(--muted)', 'text-anchor': anchor || 'middle' }, parent)
    node.textContent = text
    return node
  }

  function cartesian(type, model, options, hidden) {
    var height = options.height || 260
    var root = frame(height)
    var colors = palette()
    var left = 52, right = 12, top = 12, bottom = 28
    var plotW = W - left - right, plotH = height - top - bottom
    var visible = model.series.filter(function (_, i) { return !hidden[i] })
    var count = model.labels.length || Math.max.apply(null, model.series.map(function (s) { return s.values.length }).concat([0]))
    var totals = []
    for (var i = 0; i < count; i++) totals.push(visible.reduce(function (sum, s) { return sum + (Number(s.values[i]) || 0) }, 0))
    var values = options.stacked ? totals : visible.reduce(function (all, s) { return all.concat(s.values.map(Number)) }, [])
    var max = Math.max.apply(null, values.concat([0]))
    var min = Math.min.apply(null, values.concat([0]))
    var scale = ticks(min, max, 5)
    var low = scale[0], high = scale[scale.length - 1]
    var y = function (v) { return top + plotH - ((v - low) / (high - low || 1)) * plotH }
    scale.forEach(function (tick) {
      svg('line', { x1: left, x2: W - right, y1: y(tick), y2: y(tick), stroke: 'var(--border)' }, root)
      axisText(root, left - 6, y(tick) + 4, format(tick, options.unit), 'end')
    })
    var band = plotW / Math.max(count, 1)
    var every = Math.ceil(count / 12)
    for (var j = 0; j < count; j++) if (j % every === 0) axisText(root, left + band * j + band / 2, height - 8, (model.labels[j] || String(j + 1)).slice(0, 12))
    if (type === 'bar') {
      var groups = options.stacked ? 1 : Math.max(visible.length, 1)
      var barW = Math.min(36, (band * 0.7) / groups)
      var base = []
      model.series.forEach(function (s, index) {
        if (hidden[index]) return
        var slot = options.stacked ? 0 : visible.indexOf(s)
        s.values.forEach(function (raw, k) {
          var value = Number(raw) || 0
          var from = options.stacked ? base[k] || 0 : 0
          var x = left + band * k + (band - barW * groups) / 2 + slot * barW
          var rect = svg('rect', { x: x, y: Math.min(y(from + value), y(from)), width: Math.max(barW - 2, 1), height: Math.abs(y(from) - y(from + value)), rx: 2, fill: colors[index % colors.length] }, root)
          svg('title', {}, rect).textContent = (s.name ? s.name + ' · ' : '') + (model.labels[k] || '') + '：' + format(value, options.unit)
          if (options.stacked) base[k] = from + value
        })
      })
    } else {
      model.series.forEach(function (s, index) {
        if (hidden[index]) return
        var color = colors[index % colors.length]
        var points = s.values.map(function (raw, k) { return [left + band * k + band / 2, y(Number(raw) || 0)] })
        if (type === 'area') svg('path', { d: 'M' + points[0][0] + ',' + y(Math.max(low, 0)) + ' L' + points.map(function (p) { return p.join(',') }).join(' L') + ' L' + points[points.length - 1][0] + ',' + y(Math.max(low, 0)) + ' Z', fill: color, 'fill-opacity': 0.18 }, root)
        svg('polyline', { points: points.map(function (p) { return p.join(',') }).join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }, root)
        points.forEach(function (p, k) {
          var dot = svg('circle', { cx: p[0], cy: p[1], r: count > 30 ? 1.5 : 3, fill: 'var(--card)', stroke: color, 'stroke-width': 2 }, root)
          svg('title', {}, dot).textContent = (s.name ? s.name + ' · ' : '') + (model.labels[k] || '') + '：' + format(Number(s.values[k]), options.unit)
        })
      })
    }
    return root
  }

  function scatter(model, options, hidden) {
    var height = options.height || 260
    var root = frame(height)
    var colors = palette()
    var left = 52, right = 12, top = 12, bottom = 28
    var all = model.series.reduce(function (list, s, i) { return hidden[i] ? list : list.concat(s.values) }, [])
    var xs = ticks(Math.min.apply(null, all.map(function (p) { return p[0] }).concat([0])), Math.max.apply(null, all.map(function (p) { return p[0] }).concat([1])), 6)
    var ys = ticks(Math.min.apply(null, all.map(function (p) { return p[1] }).concat([0])), Math.max.apply(null, all.map(function (p) { return p[1] }).concat([1])), 5)
    var x = function (v) { return left + ((v - xs[0]) / (xs[xs.length - 1] - xs[0] || 1)) * (W - left - right) }
    var y = function (v) { return top + (height - top - bottom) - ((v - ys[0]) / (ys[ys.length - 1] - ys[0] || 1)) * (height - top - bottom) }
    ys.forEach(function (tick) {
      svg('line', { x1: left, x2: W - right, y1: y(tick), y2: y(tick), stroke: 'var(--border)' }, root)
      axisText(root, left - 6, y(tick) + 4, format(tick, options.unit), 'end')
    })
    xs.forEach(function (tick) { axisText(root, x(tick), height - 8, format(tick)) })
    model.series.forEach(function (s, index) {
      if (hidden[index]) return
      s.values.forEach(function (p) {
        var dot = svg('circle', { cx: x(p[0]), cy: y(p[1]), r: 4, fill: colors[index % colors.length], 'fill-opacity': 0.8 }, root)
        svg('title', {}, dot).textContent = (s.name ? s.name + '：' : '') + format(p[0]) + '，' + format(p[1], options.unit)
      })
    })
    return root
  }

  function pie(model, options, donut, hidden) {
    var height = options.height || 240
    var root = frame(height)
    var colors = palette()
    var values = (model.series[0] || { values: [] }).values.map(function (v, i) { return hidden[i] ? 0 : Math.max(Number(v) || 0, 0) })
    var total = values.reduce(function (a, b) { return a + b }, 0) || 1
    var cx = W / 2, cy = height / 2, r = height / 2 - 24, inner = donut ? r * 0.58 : 0
    var angle = -Math.PI / 2
    values.forEach(function (value, index) {
      if (!value) return
      var sweep = (value / total) * Math.PI * 2
      var end = angle + sweep
      var large = sweep > Math.PI ? 1 : 0
      var p = function (radius, a) { return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)] }
      var a1 = p(r, angle), a2 = p(r, end), b1 = p(inner, end), b2 = p(inner, angle)
      var d = sweep >= Math.PI * 2 - 1e-6
        ? 'M' + (cx - r) + ',' + cy + ' a' + r + ',' + r + ' 0 1,0 ' + 2 * r + ',0 a' + r + ',' + r + ' 0 1,0 ' + -2 * r + ',0'
        : 'M' + a1 + ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + a2 + (inner ? ' L' + b1 + ' A' + inner + ',' + inner + ' 0 ' + large + ' 0 ' + b2 : ' L' + cx + ',' + cy) + ' Z'
      var slice = svg('path', { d: d, fill: colors[index % colors.length], stroke: 'var(--card)', 'stroke-width': 2 }, root)
      var percent = Math.round((value / total) * 1000) / 10
      svg('title', {}, slice).textContent = (model.labels[index] || '') + '：' + format(value, options.unit) + '（' + percent + '%）'
      if (sweep > 0.25) {
        var mid = p(r + 14, angle + sweep / 2)
        axisText(root, mid[0], mid[1] + 4, (model.labels[index] || '') + ' ' + percent + '%', mid[0] < cx ? 'end' : 'start')
      }
      angle = end
    })
    return root
  }

  // ---- 组件 ----
  diffra.ui = {
    // card({ title, body, footer, tone: 'warning' | 'danger' | 'accent' })
    card: function (options) {
      options = options || {}
      return el('div', 'dk-card' + (options.tone ? ' dk-tone-' + options.tone : ''), [options.title ? el('div', 'dk-card-title', options.title) : null, options.body, options.footer ? el('div', 'dk-card-footer', options.footer) : null])
    },
    // stat({ label, value, unit, delta, better: 'up' | 'down' })：delta 和 better 方向相反时标成变差
    stat: function (options) {
      options = options || {}
      var delta = options.delta
      var number = typeof delta === 'number' ? delta : parseFloat(String(delta || '').replace(/[^\d.+-]/g, ''))
      var worse = options.better && isFinite(number) && number !== 0 && (number > 0) !== (options.better === 'up')
      var value = el('div', 'dk-stat-value', [typeof options.value === 'number' ? format(options.value) : options.value, options.unit ? el('span', 'dk-stat-unit', options.unit) : null])
      var arrow = isFinite(number) ? (number > 0 ? '↑ ' : number < 0 ? '↓ ' : '→ ') : ''
      return el('div', 'dk-stat', [el('div', 'dk-stat-label', options.label), value, delta !== undefined ? el('div', 'dk-stat-delta' + (worse ? ' dk-worse' : ''), arrow + (typeof delta === 'number' && delta > 0 ? '+' : '') + delta) : null])
    },
    // badge(text, tone)：tone 是 warning、danger、success、accent，不写是中性
    badge: function (text, tone) {
      return el('span', 'dk-badge' + (tone ? ' dk-tone-' + tone : ''), text)
    },
    // tabs([{ label, content }])：方向键切换
    tabs: function (items) {
      var root = el('div', 'dk-tabs')
      var list = el('div', 'dk-tabs-list')
      list.setAttribute('role', 'tablist')
      var panels = []
      var buttons = (items || []).map(function (item, index) {
        var button = el('button', 'dk-tab', item.label)
        button.setAttribute('role', 'tab')
        var panel = el('div', 'dk-tab-panel', item.content)
        panel.setAttribute('role', 'tabpanel')
        panels.push(panel)
        button.onclick = function () { select(index) }
        button.onkeydown = function (event) {
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            var next = (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
            select(next)
            buttons[next].focus()
          }
        }
        list.appendChild(button)
        return button
      })
      function select(index) {
        buttons.forEach(function (button, i) {
          button.setAttribute('aria-selected', String(i === index))
          button.tabIndex = i === index ? 0 : -1
          panels[i].hidden = i !== index
        })
      }
      root.appendChild(list)
      panels.forEach(function (panel) { root.appendChild(panel) })
      if (buttons.length) select(0)
      return root
    },
    // progress(value, { max, label })
    progress: function (value, options) {
      options = options || {}
      var max = options.max || 100
      var ratio = Math.max(0, Math.min(1, (Number(value) || 0) / max))
      var fill = el('div', 'dk-progress-fill')
      fill.style.width = ratio * 100 + '%'
      var track = el('div', 'dk-progress-track', fill)
      track.setAttribute('role', 'progressbar')
      track.setAttribute('aria-valuenow', String(value))
      track.setAttribute('aria-valuemax', String(max))
      if (options.label) track.setAttribute('aria-label', options.label)
      return el('div', 'dk-progress', [el('div', 'dk-progress-row', [el('span', '', options.label || ''), el('span', '', Math.round(ratio * 100) + '%')]), track])
    },
    // grid(children, { min: '200px' })：自动换行的网格
    grid: function (children, options) {
      var root = el('div', 'dk-grid', children)
      if (options && options.min) root.style.setProperty('--dk-min', options.min)
      return root
    },
    // table(rows, { columns })：rows 是二维数组或对象数组；数字列右对齐
    table: function (rows, options) {
      rows = rows || []
      var columns = (options && options.columns) || (rows[0] && !Array.isArray(rows[0]) ? Object.keys(rows[0]) : [])
      var table = el('table', 'dk-table')
      if (columns.length) table.appendChild(el('thead', '', el('tr', '', columns.map(function (c) { return el('th', '', c) }))))
      table.appendChild(el('tbody', '', rows.map(function (row) {
        var cells = Array.isArray(row) ? row : columns.map(function (c) { return row[c] })
        return el('tr', '', cells.map(function (cell) { return el('td', typeof cell === 'number' ? 'dk-num' : '', typeof cell === 'number' ? format(cell) : cell) }))
      })))
      return table
    },
  }

  // ---- 预设（第 667 步）：show_visual 传 preset 和 data 时 core 生成 diffra.preset(name, data)，模型只给数据 ----
  var PRESET_STYLE = [
    '.dk-preset{display:flex;flex-direction:column;gap:12px}',
    '.dk-option{gap:8px}',
    '.dk-option-head{display:flex;align-items:center;gap:8px}',
    '.dk-option ul{margin:0;padding-left:18px}',
    '.dk-option button,.dk-pick{all:unset;cursor:pointer;align-self:flex-start;border:1px solid var(--border);border-radius:6px;padding:2px 10px;font-size:12px}',
    '.dk-option button:hover,.dk-pick:hover{background:var(--accent)}',
    '.dk-muted{color:var(--muted);font-size:12px}',
    '.dk-timeline{list-style:none;margin:0;padding:0 0 0 18px;border-left:2px solid var(--border);display:flex;flex-direction:column;gap:12px}',
    '.dk-timeline li{position:relative}',
    '.dk-timeline li::before{content:"";position:absolute;left:-25px;top:5px;width:10px;height:10px;border-radius:50%;background:var(--muted);border:2px solid var(--card)}',
    '.dk-timeline li.dk-active::before{background:var(--primary)}',
    '.dk-timeline li.dk-failed::before{background:var(--danger)}',
    '.dk-timeline li.dk-pending::before{background:var(--card);border-color:var(--muted)}',
    '.dk-screens{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start}',
    '.dk-screen{border:1px solid var(--border);border-radius:12px;background:var(--card);overflow:hidden;display:flex;flex-direction:column}',
    '.dk-screen.dk-mobile{width:240px}.dk-screen.dk-desktop{width:min(560px,100%)}',
    '.dk-screen-title{font-size:12px;color:var(--muted);padding:6px 10px;border-bottom:1px solid var(--border)}',
    '.dk-screen-body{padding:10px;display:flex;flex-direction:column;gap:8px}',
    '.dk-w-nav{display:flex;gap:10px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--border);padding-bottom:6px}',
    '.dk-w-header{font-weight:700;font-size:16px}',
    '.dk-w-text{color:var(--muted);font-size:13px}',
    '.dk-w-button{align-self:flex-start;background:var(--primary);color:var(--on-primary);border-radius:6px;padding:4px 12px;font-size:12px}',
    '.dk-w-input{border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:12px;color:var(--muted)}',
    '.dk-w-image{height:90px;border-radius:6px;background:repeating-linear-gradient(45deg,var(--accent),var(--accent) 6px,var(--card) 6px,var(--card) 12px);display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--muted)}',
    '.dk-w-list{margin:0;padding-left:16px;font-size:13px}',
    '.dk-flow svg{width:100%;height:auto;display:block}',
  ].join('\n')

  function presetCompare(data) {
    var options = data.options || []
    return diffra.ui.grid(options.map(function (option) {
      var card = diffra.ui.card({
        title: el('div', 'dk-option-head', [option.name, option.recommended ? diffra.ui.badge('推荐', 'accent') : null]),
        tone: option.recommended ? 'accent' : undefined,
        body: [
          option.summary ? el('div', 'dk-muted', option.summary) : null,
          option.pros && option.pros.length ? el('ul', '', option.pros.map(function (p) { return el('li', '', '＋ ' + p) })) : null,
          option.cons && option.cons.length ? el('ul', '', option.cons.map(function (c) { return el('li', '', '－ ' + c) })) : null,
        ],
      })
      card.classList.add('dk-option')
      var pick = el('button', '', '选这个')
      pick.onclick = function () { diffra.ask('选「' + option.name + '」') }
      card.appendChild(pick)
      return card
    }), { min: '200px' })
  }

  function presetTimeline(data) {
    return el('ol', 'dk-timeline', (data.items || []).map(function (item) {
      var li = el('li', item.status ? 'dk-' + item.status : '', [
        el('div', '', [item.time ? el('span', 'dk-muted', item.time + '  ') : null, el('b', '', item.title)]),
        item.detail ? el('div', 'dk-muted', item.detail) : null,
      ])
      return li
    }))
  }

  function presetMockup(data) {
    var BLOCKS = {
      nav: function (b) { return el('div', 'dk-w-nav', (b.items || [b.text || '首页']).map(function (t) { return el('span', '', t) })) },
      header: function (b) { return el('div', 'dk-w-header', b.text || '标题') },
      text: function (b) { return el('div', 'dk-w-text', b.text || '一段说明文字') },
      button: function (b) { return el('div', 'dk-w-button', b.text || '按钮') },
      input: function (b) { return el('div', 'dk-w-input', b.text || '输入…') },
      image: function (b) { return el('div', 'dk-w-image', b.text || '图片') },
      list: function (b) { return el('ul', 'dk-w-list', (b.items || ['第一项', '第二项']).map(function (t) { return el('li', '', t) })) },
      card: function (b) { return diffra.ui.card({ title: b.text, body: b.items ? el('div', 'dk-muted', b.items.join(' · ')) : null }) },
      table: function (b) { return diffra.ui.table((b.items || []).map(function (row) { return String(row).split('|') })) },
    }
    return el('div', 'dk-screens', (data.screens || []).map(function (screen) {
      return el('div', 'dk-screen ' + (screen.device === 'mobile' || data.device === 'mobile' ? 'dk-mobile' : 'dk-desktop'), [
        screen.title ? el('div', 'dk-screen-title', screen.title) : null,
        el('div', 'dk-screen-body', (screen.blocks || []).map(function (block) { return (BLOCKS[block.kind] || BLOCKS.text)(block) })),
      ])
    }))
  }

  // 流程图：按最长路径分层，LR 一层一列、TD 一层一行；节点是圆角框，判断是菱形，开始和结束是胶囊
  function presetFlow(data) {
    var nodes = data.nodes || []
    var edges = data.edges || []
    var vertical = data.direction === 'TD'
    var rank = {}
    nodes.forEach(function (n) { rank[n.id] = 0 })
    for (var pass = 0; pass < nodes.length; pass++) {
      var changed = false
      edges.forEach(function (e) {
        if (rank[e.from] === undefined || rank[e.to] === undefined) return
        if (rank[e.to] < rank[e.from] + 1 && rank[e.from] + 1 < nodes.length) {
          rank[e.to] = rank[e.from] + 1
          changed = true
        }
      })
      if (!changed) break
    }
    var layers = []
    nodes.forEach(function (n) { (layers[rank[n.id]] = layers[rank[n.id]] || []).push(n) })
    var NW = 132, NH = 40, GAP_MAIN = 64, GAP_CROSS = 22
    var maxCross = Math.max.apply(null, layers.map(function (l) { return l.length }).concat([1]))
    var width = vertical ? maxCross * (NW + GAP_CROSS) : layers.length * (NW + GAP_MAIN)
    var height = vertical ? layers.length * (NH + GAP_MAIN) : maxCross * (NH + GAP_CROSS)
    var pos = {}
    layers.forEach(function (layer, li) {
      layer.forEach(function (n, ni) {
        var offset = ((maxCross - layer.length) * ((vertical ? NW : NH) + GAP_CROSS)) / 2
        pos[n.id] = vertical
          ? { x: offset + ni * (NW + GAP_CROSS) + NW / 2 + GAP_CROSS / 2, y: li * (NH + GAP_MAIN) + NH / 2 + 8 }
          : { x: li * (NW + GAP_MAIN) + NW / 2 + 8, y: offset + ni * (NH + GAP_CROSS) + NH / 2 + GAP_CROSS / 2 }
      })
    })
    var root = svg('svg', { viewBox: '0 0 ' + (width + 16) + ' ' + (height + 16), 'font-size': 12, 'font-family': 'inherit', role: 'img', 'aria-label': '流程图：' + nodes.map(function (n) { return n.label }).join(' → ') })
    var defs = svg('defs', {}, root)
    var marker = svg('marker', { id: 'dk-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs)
    svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--muted)' }, marker)
    edges.forEach(function (e) {
      var a = pos[e.from], b = pos[e.to]
      if (!a || !b) return
      var x1 = vertical ? a.x : a.x + NW / 2, y1 = vertical ? a.y + NH / 2 : a.y
      var x2 = vertical ? b.x : b.x - NW / 2, y2 = vertical ? b.y - NH / 2 : b.y
      svg('line', { x1: x1, y1: y1, x2: x2, y2: y2, stroke: 'var(--muted)', 'stroke-width': 1.5, 'marker-end': 'url(#dk-arrow)' }, root)
      if (e.label) {
        var t = svg('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 4, fill: 'var(--muted)', 'text-anchor': 'middle' }, root)
        t.textContent = e.label
      }
    })
    nodes.forEach(function (n) {
      var p = pos[n.id]
      if (n.kind === 'decision') svg('path', { d: 'M' + p.x + ',' + (p.y - NH / 2 - 4) + ' L' + (p.x + NW / 2) + ',' + p.y + ' L' + p.x + ',' + (p.y + NH / 2 + 4) + ' L' + (p.x - NW / 2) + ',' + p.y + ' Z', fill: 'var(--card)', stroke: 'var(--border)', 'stroke-width': 1.5 }, root)
      else svg('rect', { x: p.x - NW / 2, y: p.y - NH / 2, width: NW, height: NH, rx: n.kind === 'start' || n.kind === 'end' ? NH / 2 : 8, fill: n.kind === 'start' || n.kind === 'end' ? 'var(--soft)' : 'var(--card)', stroke: 'var(--border)', 'stroke-width': 1.5 }, root)
      var label = svg('text', { x: p.x, y: p.y + 4, fill: 'var(--fg)', 'text-anchor': 'middle' }, root)
      label.textContent = String(n.label).length > 14 ? String(n.label).slice(0, 13) + '…' : n.label
      svg('title', {}, label).textContent = n.label
    })
    return el('div', 'dk-flow', root)
  }

  function presetCards(data) {
    return diffra.ui.grid((data.items || []).map(function (item) { return diffra.ui.stat(item) }), { min: '150px' })
  }

  var PRESETS = {
    compare: presetCompare,
    timeline: presetTimeline,
    chart: function (data) { return diffra.chart(data.type, data.data, data.options || {}) },
    mockup: presetMockup,
    flow: presetFlow,
    cards: presetCards,
  }

  diffra.preset = function (name, data) {
    if (!document.getElementById('dk-preset-style')) {
      var presetStyle = document.createElement('style')
      presetStyle.id = 'dk-preset-style'
      presetStyle.textContent = PRESET_STYLE
      document.head.appendChild(presetStyle)
    }
    var root = el('div', 'dk-preset dk-preset-' + name, [data && data.intro ? el('div', 'dk-muted', data.intro) : null, (PRESETS[name] || presetCards)(data || {})])
    document.body.appendChild(root)
    return root
  }

  // ---- 交给主界面的动作（白名单）----
  // 打开项目里的文件（主界面查过在项目里才开）；打开网页（先在卡片下面问用户）；复制文字；把问题填进输入框（不发送）
  diffra.openFile = function (path, line) { send({ type: 'diffra-visual-open-file', path: String(path), line: typeof line === 'number' ? line : null }) }
  diffra.openBrowser = function (url) { if (/^https?:/i.test(String(url))) send({ type: 'diffra-visual-link', href: String(url) }) }
  diffra.copy = function (text) { send({ type: 'diffra-visual-copy', text: String(text) }) }
  diffra.ask = function (text) { send({ type: 'diffra-visual-fill', text: String(text) }) }

  // ---- 演示模式：带 data-step 的元素按顺序出现（第 669 步）----
  var stepped = function () { return Array.prototype.slice.call(document.querySelectorAll('[data-step]')) }
  window.addEventListener('message', function (event) {
    if (event.source !== parent || !event.data || event.data.type !== 'diffra-visual-step') return
    var step = event.data.step
    stepped().forEach(function (node) {
      var own = Number(node.getAttribute('data-step')) || 0
      node.classList.toggle('dk-hidden', step !== null && own > step)
    })
  })
  window.addEventListener('load', function () {
    var steps = stepped().map(function (node) { return Number(node.getAttribute('data-step')) || 0 })
    send({ type: 'diffra-visual-steps', count: steps.length ? Math.max.apply(null, steps) : 0 })
  })
})()
