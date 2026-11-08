<script setup lang="ts">
import type { MixedValue } from '@open-pencil/vue/controls/node-props'
import { ref, watch } from 'vue'
import { isMixed, showNumber } from './ui'

// 数字输入：回车或失焦时提交；上下方向键按 1 调整（Shift 按 10）
const props = defineProps<{ label: string; value: MixedValue<number>; min?: number; suffix?: string }>()
const emit = defineEmits<{ commit: [value: number, previous: number] }>()

const text = ref(showNumber(props.value))
watch(
  () => props.value,
  (value) => (text.value = showNumber(value)),
)

function commit(next: number) {
  const previous = isMixed(props.value) ? next : props.value
  const value = props.min === undefined ? next : Math.max(props.min, next)
  if (!Number.isFinite(value) || value === previous) {
    text.value = showNumber(props.value)
    return
  }
  emit('commit', value, previous)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
  if (event.key === 'Escape') {
    text.value = showNumber(props.value)
    ;(event.target as HTMLInputElement).blur()
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault()
    const base = isMixed(props.value) ? 0 : props.value
    commit(base + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1))
  }
}
</script>

<template>
  <label class="flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-muted px-2 text-xs focus-within:ring-1 focus-within:ring-ring/60">
    <span class="shrink-0 text-muted-foreground">{{ label }}</span>
    <input
      v-model="text"
      :aria-label="label"
      class="w-full min-w-0 bg-transparent text-foreground tabular-nums outline-none"
      @focus="($event.target as HTMLInputElement).select()"
      @keydown="onKeydown"
      @change="commit(Number(text))"
    />
    <span v-if="suffix" class="shrink-0 text-muted-foreground">{{ suffix }}</span>
  </label>
</template>
