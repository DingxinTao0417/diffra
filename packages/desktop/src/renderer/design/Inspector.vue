<script setup lang="ts">
import { fontManager } from '@open-pencil/core/text'
import { useEditor } from '@open-pencil/vue'
import { useAppearance } from '@open-pencil/vue/controls/appearance'
import { useFillControls } from '@open-pencil/vue/controls/fill'
import { useLayout } from '@open-pencil/vue/controls/layout'
import { usePosition } from '@open-pencil/vue/controls/position'
import { useEditorPropertyList } from '@open-pencil/vue/controls/property-list'
import { useStrokeControls } from '@open-pencil/vue/controls/stroke'
import { useTypography } from '@open-pencil/vue/controls/typography'
import { useSelectionState } from '@open-pencil/vue/editor/selection-state'
import { computed, onMounted, ref } from 'vue'
import NumField from './NumField.vue'
import { fromHex, isMixed, toHex } from './ui'

// 右侧属性面板：选中图层的位置尺寸、自动布局、外观、填充、描边、文字
const editor = useEditor()
const selection = useSelectionState()
const position = usePosition()
const layout = useLayout()
const appearance = useAppearance()
const fills = useEditorPropertyList('fills')
const strokes = useEditorPropertyList('strokes')
const fillControls = useFillControls()
const strokeControls = useStrokeControls()
// 场景图的类型不直接依赖 @open-pencil/scene-graph，从 SDK 的返回值里取
type FillItem = (typeof fills.items.value)[number]
type StrokeItem = (typeof strokes.items.value)[number]
type LayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID'
type LayoutSizing = 'FIXED' | 'HUG' | 'FILL'
type StrokeAlign = StrokeItem['align']
const typography = useTypography({ fontLoader: { load: (family, style) => fontManager.loadFont(family, style) } })

const families = ref<string[]>([])
onMounted(() => {
  fontManager.listFamilies().then(
    (list) => (families.value = list),
    (error: unknown) => console.error('读取字体列表失败', error),
  )
})

const node = computed(() => selection.selectedNode.value)
const isText = computed(() => selection.selectedNodeType.value === 'TEXT')
const canLayout = computed(() => ['FRAME', 'COMPONENT', 'INSTANCE', 'SECTION'].includes(selection.selectedNodeType.value ?? ''))

const LAYOUT_MODES: Array<{ value: LayoutMode; label: string }> = [
  { value: 'NONE', label: '无' },
  { value: 'HORIZONTAL', label: '横向' },
  { value: 'VERTICAL', label: '纵向' },
  { value: 'GRID', label: '网格' },
]
const SIZING_LABELS: Record<LayoutSizing, string> = { FIXED: '固定', HUG: '包裹', FILL: '填充' }
const ALIGNS = [
  { value: 'LEFT', label: '左' },
  { value: 'CENTER', label: '中' },
  { value: 'RIGHT', label: '右' },
  { value: 'JUSTIFIED', label: '两端' },
] as const

function setPosition(key: 'x' | 'y' | 'width' | 'height' | 'rotation', value: number, previous: number) {
  position.updateProp(key, value)
  position.commitProp(key, value, previous)
}

function setLayoutNumber(key: 'itemSpacing', value: number, previous: number) {
  layout.updateProp(key, value)
  layout.commitProp(key, value, previous)
}

function setColor(list: typeof fills | typeof strokes, index: number, item: FillItem | StrokeItem, hex: string) {
  const color = fromHex(hex, item.color.a)
  if (color) list.actions.patch(index, { color })
}

function setTypographyNumber(key: 'fontSize', value: number, previous: number) {
  typography.updateProp(key, value)
  typography.commitProp(key, value, previous)
}

function setTextLength(key: 'lineHeight' | 'letterSpacing', value: number) {
  const previous = node.value?.[key] ?? null
  typography.updateProp(key, { value, unit: 'PIXELS' })
  typography.commitProp(key, { value, unit: 'PIXELS' }, previous)
}

const lineHeight = computed(() => node.value?.lineHeight?.value ?? 0)
const letterSpacing = computed(() => node.value?.letterSpacing?.value ?? 0)
</script>

<template>
  <aside class="flex w-64 shrink-0 flex-col overflow-y-auto border-l border-border bg-background text-xs" data-testid="design-inspector">
    <p v-if="!node" class="px-3 py-4 leading-relaxed text-muted-foreground">选中图层后在这里调整位置、布局、颜色和文字。</p>
    <template v-else>
      <div class="flex h-8 shrink-0 items-center px-3 font-medium">
        <span class="truncate">{{ selection.selectedCount.value > 1 ? `${selection.selectedCount.value} 个图层` : node.name }}</span>
      </div>

      <section class="space-y-1.5 border-t border-border px-3 py-2.5">
        <h3 class="font-medium text-muted-foreground">位置和尺寸</h3>
        <div class="grid grid-cols-2 gap-1.5">
          <NumField label="X" :value="position.x.value" @commit="(v, p) => setPosition('x', v, p)" />
          <NumField label="Y" :value="position.y.value" @commit="(v, p) => setPosition('y', v, p)" />
          <NumField label="宽" :value="position.width.value" :min="0" @commit="(v, p) => setPosition('width', v, p)" />
          <NumField label="高" :value="position.height.value" :min="0" @commit="(v, p) => setPosition('height', v, p)" />
          <NumField label="旋转" :value="position.rotation.value" suffix="°" @commit="(v, p) => setPosition('rotation', v, p)" />
        </div>
        <div class="flex gap-0.5">
          <button v-for="pos in (['min', 'center', 'max'] as const)" :key="`h-${pos}`" type="button" class="h-6 flex-1 rounded bg-muted hover:bg-accent" :title="`水平${{ min: '左', center: '居中', max: '右' }[pos]}对齐`" @click="position.align('horizontal', pos)">
            {{ { min: '左', center: '中', max: '右' }[pos] }}
          </button>
          <button v-for="pos in (['min', 'center', 'max'] as const)" :key="`v-${pos}`" type="button" class="h-6 flex-1 rounded bg-muted hover:bg-accent" :title="`垂直${{ min: '顶', center: '居中', max: '底' }[pos]}对齐`" @click="position.align('vertical', pos)">
            {{ { min: '顶', center: '中', max: '底' }[pos] }}
          </button>
        </div>
      </section>

      <section v-if="canLayout && selection.selectedCount.value === 1" class="space-y-1.5 border-t border-border px-3 py-2.5">
        <h3 class="font-medium text-muted-foreground">自动布局</h3>
        <div class="flex gap-0.5 rounded-md bg-muted p-0.5">
          <button
            v-for="mode in LAYOUT_MODES"
            :key="mode.value"
            type="button"
            class="h-6 flex-1 rounded"
            :class="node.layoutMode === mode.value ? 'bg-background shadow-xs ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'"
            :aria-pressed="node.layoutMode === mode.value"
            @click="editor.setLayoutMode(node.id, mode.value)"
          >
            {{ mode.label }}
          </button>
        </div>
        <template v-if="layout.isFlex.value">
          <div class="grid grid-cols-2 gap-1.5">
            <NumField label="间距" :value="node.itemSpacing" :min="0" @commit="(v, p) => setLayoutNumber('itemSpacing', v, p)" />
            <NumField label="左右" :value="node.paddingLeft" :min="0" @commit="(v, p) => (layout.setHorizontalPadding(v), layout.commitHorizontalPadding(v, p))" />
            <NumField label="上下" :value="node.paddingTop" :min="0" @commit="(v, p) => (layout.setVerticalPadding(v), layout.commitVerticalPadding(v, p))" />
          </div>
          <div class="grid w-20 grid-cols-3 gap-0.5" aria-label="对齐方式">
            <button
              v-for="(cell, index) in layout.alignGrid.value"
              :key="index"
              type="button"
              class="size-6 rounded"
              :class="node.primaryAxisAlign === cell.primary && node.counterAxisAlign === cell.counter ? 'bg-primary' : 'bg-muted hover:bg-accent'"
              :title="`${cell.primary} / ${cell.counter}`"
              @click="layout.setAlignment(cell.primary, cell.counter)"
            />
          </div>
        </template>
        <div class="grid grid-cols-2 gap-1.5">
          <label v-for="axis in (['width', 'height'] as const)" :key="axis" class="flex h-7 items-center gap-1.5 rounded-md bg-muted px-2">
            <span class="text-muted-foreground">{{ axis === 'width' ? '宽' : '高' }}</span>
            <select
              class="min-w-0 flex-1 bg-transparent outline-none"
              :aria-label="`${axis === 'width' ? '宽度' : '高度'}方式`"
              :value="axis === 'width' ? layout.widthSizing.value : layout.heightSizing.value"
              @change="layout.setAxisSizing(axis, ($event.target as HTMLSelectElement).value as LayoutSizing)"
            >
              <option v-for="option in axis === 'width' ? layout.widthSizingOptions.value : layout.heightSizingOptions.value" :key="option.value" :value="option.value">
                {{ SIZING_LABELS[option.value] }}
              </option>
            </select>
          </label>
        </div>
      </section>

      <section class="space-y-1.5 border-t border-border px-3 py-2.5">
        <h3 class="flex items-center justify-between font-medium text-muted-foreground">
          外观
          <button type="button" class="rounded px-1.5 hover:bg-accent hover:text-foreground" @click="appearance.toggleVisibility()">
            {{ appearance.visibilityState.value === 'hidden' ? '显示' : '隐藏' }}
          </button>
        </h3>
        <div class="grid grid-cols-2 gap-1.5">
          <NumField
            label="不透明"
            suffix="%"
            :min="0"
            :value="appearance.opacityPercent.value"
            @commit="(v, p) => (appearance.updateProp('opacity', Math.min(100, v) / 100), appearance.commitProp('opacity', Math.min(100, v) / 100, p / 100))"
          />
          <NumField
            v-if="appearance.hasCornerRadius.value"
            label="圆角"
            :min="0"
            :value="appearance.cornerRadiusValue.value"
            @commit="(v) => (appearance.updateUniformRadius(v), appearance.commitUniformRadius())"
          />
        </div>
      </section>

      <section class="space-y-1.5 border-t border-border px-3 py-2.5">
        <h3 class="flex items-center justify-between font-medium text-muted-foreground">
          填充
          <button type="button" class="rounded px-1.5 hover:bg-accent hover:text-foreground" title="添加填充" @click="fills.actions.add(fillControls.defaultFill)">＋</button>
        </h3>
        <p v-if="fills.isMixed.value" class="text-muted-foreground">多个图层的填充不同</p>
        <div v-for="(fill, index) in fills.items.value" v-else :key="index" class="flex items-center gap-1.5">
          <template v-if="fill.type === 'SOLID'">
            <input type="color" class="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent" :aria-label="`填充 ${index + 1} 颜色`" :value="toHex(fill.color)" @change="setColor(fills, index, fill, ($event.target as HTMLInputElement).value)" />
            <input class="h-7 min-w-0 flex-1 rounded-md bg-muted px-2 uppercase outline-none focus:ring-1 focus:ring-ring/60" :aria-label="`填充 ${index + 1} 色值`" :value="toHex(fill.color)" @change="setColor(fills, index, fill, ($event.target as HTMLInputElement).value)" />
          </template>
          <span v-else class="h-7 flex-1 rounded-md bg-muted px-2 leading-7 text-muted-foreground">{{ fill.type === 'IMAGE' ? '图片' : '渐变' }}</span>
          <button type="button" class="rounded px-1 text-muted-foreground hover:text-foreground" :title="fill.visible ? '隐藏这层' : '显示这层'" @click="fills.actions.toggleVisibility(index)">{{ fill.visible ? '显' : '隐' }}</button>
          <button type="button" class="rounded px-1 text-muted-foreground hover:text-foreground" title="删除这层" @click="fills.actions.remove(index)">×</button>
        </div>
      </section>

      <section class="space-y-1.5 border-t border-border px-3 py-2.5">
        <h3 class="flex items-center justify-between font-medium text-muted-foreground">
          描边
          <button type="button" class="rounded px-1.5 hover:bg-accent hover:text-foreground" title="添加描边" @click="strokes.actions.add(strokeControls.defaultStroke)">＋</button>
        </h3>
        <p v-if="strokes.isMixed.value" class="text-muted-foreground">多个图层的描边不同</p>
        <div v-for="(stroke, index) in strokes.items.value" v-else :key="index" class="flex items-center gap-1.5">
          <input type="color" class="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent" :aria-label="`描边 ${index + 1} 颜色`" :value="toHex(stroke.color)" @change="setColor(strokes, index, stroke, ($event.target as HTMLInputElement).value)" />
          <div class="w-20 shrink-0">
            <NumField label="粗" :min="0" :value="stroke.weight" @commit="(v) => strokes.actions.patch(index, { weight: v })" />
          </div>
          <select class="h-7 min-w-0 flex-1 rounded-md bg-muted px-1 outline-none" :aria-label="`描边 ${index + 1} 位置`" :value="stroke.align" @change="strokes.actions.patch(index, { align: ($event.target as HTMLSelectElement).value as StrokeAlign })">
            <option value="INSIDE">内侧</option>
            <option value="CENTER">居中</option>
            <option value="OUTSIDE">外侧</option>
          </select>
          <button type="button" class="rounded px-1 text-muted-foreground hover:text-foreground" title="删除描边" @click="strokes.actions.remove(index)">×</button>
        </div>
      </section>

      <section v-if="isText" class="space-y-1.5 border-t border-border px-3 py-2.5">
        <h3 class="font-medium text-muted-foreground">文字</h3>
        <input
          list="design-font-families"
          class="h-7 w-full rounded-md bg-muted px-2 outline-none focus:ring-1 focus:ring-ring/60"
          aria-label="字体"
          :value="typography.fontFamily.value"
          @change="typography.setFamily(($event.target as HTMLInputElement).value)"
        />
        <datalist id="design-font-families">
          <option v-for="family in families" :key="family" :value="family" />
        </datalist>
        <div class="grid grid-cols-2 gap-1.5">
          <select
            class="h-7 min-w-0 rounded-md bg-muted px-1 outline-none"
            aria-label="字重"
            :value="isMixed(typography.faceName.value) ? '' : typography.faceName.value"
            @change="typography.setFace(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="face in typography.faces.value" :key="face.value" :value="face.value">{{ face.label }}</option>
          </select>
          <NumField label="字号" :min="1" :value="typography.fontSize.value" @commit="(v, p) => setTypographyNumber('fontSize', v, p)" />
          <NumField label="行高" :min="0" :value="lineHeight" @commit="(v) => setTextLength('lineHeight', v)" />
          <NumField label="字距" :value="letterSpacing" @commit="(v) => setTextLength('letterSpacing', v)" />
        </div>
        <div class="flex gap-0.5">
          <button
            v-for="align in ALIGNS"
            :key="align.value"
            type="button"
            class="h-6 flex-1 rounded"
            :class="node.textAlignHorizontal === align.value ? 'bg-soft text-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'"
            @click="typography.setAlign(align.value)"
          >
            {{ align.label }}
          </button>
          <button type="button" class="h-6 flex-1 rounded bg-muted font-bold hover:bg-accent" title="粗体" @click="typography.toggleBold()">B</button>
          <button type="button" class="h-6 flex-1 rounded bg-muted italic hover:bg-accent" title="斜体" @click="typography.toggleItalic()">I</button>
          <button type="button" class="h-6 flex-1 rounded bg-muted underline hover:bg-accent" title="下划线" @click="typography.toggleDecoration('UNDERLINE')">U</button>
        </div>
      </section>
    </template>
  </aside>
</template>
