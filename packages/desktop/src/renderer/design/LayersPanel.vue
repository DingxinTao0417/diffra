<script setup lang="ts">
import { useEditor } from '@open-pencil/vue'
import { LayerTreeItem, LayerTreeRoot } from '@open-pencil/vue/primitives/LayerTree'
import { PageListRoot } from '@open-pencil/vue/primitives/PageList'
import { nextTick, ref } from 'vue'

// 左侧：页面列表和图层树。双击改名，眼睛和锁切换显示、锁定
const editor = useEditor()
const renaming = ref<{ kind: 'page' | 'layer'; id: string; name: string } | null>(null)
const renameInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null)

const TYPE_LABELS: Record<string, string> = {
  FRAME: '板',
  SECTION: '区',
  GROUP: '组',
  COMPONENT: '件',
  COMPONENT_SET: '件',
  INSTANCE: '例',
  TEXT: '字',
  RECTANGLE: '矩',
  ELLIPSE: '圆',
  LINE: '线',
  VECTOR: '矢',
  POLYGON: '多',
  STAR: '星',
  BOOLEAN_OPERATION: '布',
}

async function startRename(kind: 'page' | 'layer', id: string, name: string) {
  renaming.value = { kind, id, name }
  await nextTick()
  const input = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value
  input?.select()
}

// 图层的显示、锁定状态不在行数据里；参数 version 是图层树的版本号，树变了这一行跟着重画
function nodeState(id: string, _version: number) {
  const node = editor.graph.getNode(id)
  return { visible: node?.visible !== false, locked: node?.locked === true }
}
</script>

<template>
  <aside class="flex w-56 shrink-0 flex-col border-r border-border bg-background text-xs" data-testid="design-layers">
    <PageListRoot v-slot="{ pages, currentPageId, actions }">
      <div class="flex h-8 shrink-0 items-center justify-between px-3 font-medium text-muted-foreground">
        <span>页面</span>
        <button type="button" class="rounded px-1.5 hover:bg-accent hover:text-foreground" title="新建页面" @click="actions.add()">＋</button>
      </div>
      <ul class="max-h-36 shrink-0 overflow-y-auto px-1.5 pb-1.5">
        <li v-for="page in pages" :key="page.id" class="group flex items-center">
          <input
            v-if="renaming?.kind === 'page' && renaming.id === page.id"
            ref="renameInput"
            v-model="renaming.name"
            aria-label="页面名称"
            class="h-6 w-full rounded bg-muted px-2 outline-none ring-1 ring-ring/60"
            @keydown.enter="($event.target as HTMLInputElement).blur()"
            @keydown.escape="renaming = null"
            @blur="renaming && (renaming.name.trim() && actions.rename(page.id, renaming.name.trim()), (renaming = null))"
          />
          <button
            v-else
            type="button"
            class="h-6 min-w-0 flex-1 truncate rounded px-2 text-left hover:bg-accent"
            :class="page.id === currentPageId ? 'bg-soft font-medium text-foreground' : 'text-muted-foreground'"
            @click="actions.switch(page.id)"
            @dblclick="startRename('page', page.id, page.name)"
          >
            {{ page.name }}
          </button>
          <button
            v-if="pages.length > 1"
            type="button"
            class="ml-0.5 hidden rounded px-1 text-muted-foreground group-hover:block hover:bg-accent hover:text-foreground"
            title="删除页面"
            @click="actions.delete(page.id)"
          >
            ×
          </button>
        </li>
      </ul>
    </PageListRoot>
    <div class="flex h-8 shrink-0 items-center border-t border-border px-3 font-medium text-muted-foreground">图层</div>
    <div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
      <LayerTreeRoot v-slot="{ visibleRows, treeVersion }" :indent-per-level="12">
        <p v-if="visibleRows.length === 0" class="px-2 py-3 text-muted-foreground">这一页还没有图层</p>
        <LayerTreeItem
          v-for="row in visibleRows"
          :key="row.node.id"
          v-slot="{ node, isSelected, padLeft, actions, hasChildren }"
          :node="row.node"
          :level="row.level"
          :has-children="row.hasChildren"
        >
          <div
            class="group flex h-6 items-center gap-1 rounded pr-1"
            :class="isSelected ? 'bg-soft text-foreground' : 'text-muted-foreground hover:bg-accent'"
            :style="{ paddingLeft: padLeft }"
            :data-testid="`layer-${node.name}`"
          >
            <button type="button" class="w-3 shrink-0 text-xs" :class="hasChildren ? '' : 'invisible'" :aria-label="`展开 ${node.name}`" @click="actions.toggleExpand()">▸</button>
            <span class="w-4 shrink-0 text-center text-xs opacity-70">{{ TYPE_LABELS[node.type] ?? '·' }}</span>
            <input
              v-if="renaming?.kind === 'layer' && renaming.id === node.id"
              ref="renameInput"
              v-model="renaming.name"
              aria-label="图层名称"
              class="h-5 min-w-0 flex-1 rounded bg-muted px-1 outline-none ring-1 ring-ring/60"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
              @keydown.escape="renaming = null"
              @blur="renaming && (renaming.name.trim() && actions.rename(renaming.name.trim()), (renaming = null))"
            />
            <button
              v-else
              type="button"
              class="min-w-0 flex-1 truncate text-left"
              :class="nodeState(node.id, treeVersion).visible ? '' : 'opacity-50'"
              @click="actions.select($event.shiftKey || $event.ctrlKey || $event.metaKey)"
              @dblclick="startRename('layer', node.id, node.name)"
            >
              {{ node.name }}
            </button>
            <button
              type="button"
              class="shrink-0 rounded px-0.5 hover:text-foreground"
              :class="nodeState(node.id, treeVersion).locked ? '' : 'invisible group-hover:visible'"
              :title="nodeState(node.id, treeVersion).locked ? '解锁' : '锁定'"
              @click="actions.toggleLock()"
            >
              {{ nodeState(node.id, treeVersion).locked ? '锁' : '开' }}
            </button>
            <button
              type="button"
              class="shrink-0 rounded px-0.5 hover:text-foreground"
              :class="nodeState(node.id, treeVersion).visible ? 'invisible group-hover:visible' : ''"
              :title="nodeState(node.id, treeVersion).visible ? '隐藏' : '显示'"
              @click="actions.toggleVisibility()"
            >
              {{ nodeState(node.id, treeVersion).visible ? '显' : '隐' }}
            </button>
          </div>
        </LayerTreeItem>
      </LayerTreeRoot>
    </div>
  </aside>
</template>
