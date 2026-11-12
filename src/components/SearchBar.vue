<script setup lang="ts">
import { ref, watch, nextTick } from "vue"
import { Search, ChevronUp, ChevronDown, CaseSensitive, X } from "@lucide/vue"

const props = defineProps<{
  show: boolean
  modelValue: string
  currentMatch: number
  totalMatches: number
  isCaseSensitive: boolean
}>()

const emit = defineEmits<{
  (e: "update:modelValue", val: string): void
  (e: "update:show", val: boolean): void
  (e: "toggleCaseSensitive"): void
  (e: "next"): void
  (e: "prev"): void
  (e: "close"): void
}>()

const inputRef = ref<HTMLInputElement | null>(null)

watch(
  () => props.show,
  (visible) => {
    if (visible) {
      nextTick(() => {
        inputRef.value?.focus()
        inputRef.value?.select()
      })
    }
  },
)

function onKeyDown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    event.preventDefault()
    if (event.shiftKey) {
      emit("prev")
    } else {
      emit("next")
    }
  } else if (event.key === "Escape") {
    event.preventDefault()
    emit("close")
  }
}
</script>

<template>
  <div
    v-if="show"
    class="absolute top-3 right-6 z-40 bg-popover/95 text-popover-foreground border shadow-xl rounded-xl p-1.5 flex items-center gap-1 backdrop-blur-md animate-in fade-in slide-in-from-top-2 duration-150"
  >
    <div class="flex items-center px-2 gap-1.5 text-muted-foreground">
      <Search class="size-3.5" />
    </div>

    <input
      ref="inputRef"
      type="text"
      :value="modelValue"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown="onKeyDown"
      placeholder="查找文档内容..."
      class="h-7 w-44 md:w-56 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
    />

    <!-- 匹配计数 -->
    <div class="text-[11px] font-mono px-2 text-muted-foreground select-none shrink-0 min-w-[3.5rem] text-right">
      <template v-if="modelValue">
        {{ totalMatches > 0 ? `${currentMatch + 1}/${totalMatches}` : "无结果" }}
      </template>
    </div>

    <!-- 大小写区分按钮 -->
    <button
      :class="[
        'size-7 rounded flex items-center justify-center transition cursor-pointer',
        isCaseSensitive ? 'bg-primary text-primary-foreground font-semibold' : 'text-muted-foreground hover:bg-muted',
      ]"
      @click="emit('toggleCaseSensitive')"
      title="区分大小写 (Match Case)"
    >
      <CaseSensitive class="size-4" />
    </button>

    <!-- 上一个 -->
    <button
      class="size-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer disabled:opacity-30 disabled:pointer-events-none"
      :disabled="totalMatches === 0"
      @click="emit('prev')"
      title="上一个 (Shift+Enter)"
    >
      <ChevronUp class="size-4" />
    </button>

    <!-- 下一个 -->
    <button
      class="size-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer disabled:opacity-30 disabled:pointer-events-none"
      :disabled="totalMatches === 0"
      @click="emit('next')"
      title="下一个 (Enter)"
    >
      <ChevronDown class="size-4" />
    </button>

    <!-- 关闭 -->
    <button
      class="size-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer"
      @click="emit('close')"
      title="关闭 (Esc)"
    >
      <X class="size-4" />
    </button>
  </div>
</template>
