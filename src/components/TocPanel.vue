<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue"
import { Search, X } from "@lucide/vue"
import { Badge } from "@/components/ui/badge"
import type { TocItem } from "@/lib/markdown"

const props = defineProps<{
  isOpen: boolean
  toc: TocItem[]
  activeHeadingId: string | null
  compact?: boolean
  overlay?: boolean
}>()

const emit = defineEmits<{
  (e: "select", id: string): void
  (e: "close"): void
}>()

const searchQuery = ref("")
const tocContainerRef = ref<HTMLElement | null>(null)

const filteredToc = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return props.toc
  return props.toc.filter((item) => item.text.toLowerCase().includes(q))
})

// 仅当 activeHeadingId 真正改变时，才平滑滚动目录列表中的对应项，彻底杜绝打架抽动
watch(
  () => props.activeHeadingId,
  (newId) => {
    if (!newId || !props.isOpen) return
    nextTick(() => {
      const activeEl = tocContainerRef.value?.querySelector(`[data-toc-id="${newId}"]`) as HTMLElement | null
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" })
      }
    })
  },
)

function getPaddingClass(level: number) {
  switch (level) {
    case 1:
      return "pl-2.5 font-medium text-foreground/90"
    case 2:
      return "pl-5 text-foreground/80"
    case 3:
      return "pl-7 text-muted-foreground text-[11px]"
    case 4:
      return "pl-9 text-muted-foreground/75 text-[10px]"
    default:
      return "pl-2.5 text-foreground/80"
  }
}
</script>

<template>
  <aside
    :class="[
      'shrink-0 border-l flex flex-col transition-all duration-300 ease-in-out h-full max-h-full overflow-hidden select-none',
      overlay
        ? 'absolute right-0 top-0 bottom-0 z-30 bg-background/95 backdrop-blur-md shadow-xl'
        : 'bg-muted/10',
      isOpen
        ? (compact ? 'w-[196px]' : 'w-[230px]')
        : 'w-0 border-l-0 pointer-events-none',
    ]"
  >
    <!-- 目录头部与快速过滤输入框 -->
    <div class="p-2.5 border-b space-y-2 shrink-0">
      <div class="flex items-center justify-between gap-1.5">
        <div class="text-xs font-semibold text-muted-foreground">大纲目录</div>
        <div class="flex items-center gap-1">
          <Badge variant="outline" class="text-[10px] px-1.5 rounded-full py-0">
            {{ filteredToc.length }}
          </Badge>
          <button
            v-if="overlay"
            @click="emit('close')"
            class="size-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer"
            title="收起大纲"
          >
            <X class="size-3" />
          </button>
        </div>
      </div>

      <!-- 目录过滤框 -->
      <div class="relative">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="过滤目录章节..."
          class="w-full bg-background/80 border text-[11px] rounded-md pl-6 pr-6 py-1 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 transition"
        />
        <Search class="size-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <button
          v-if="searchQuery"
          @click="searchQuery = ''"
          class="size-3.5 absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer flex items-center justify-center rounded-full hover:bg-muted"
        >
          <X class="size-2.5" />
        </button>
      </div>
    </div>

    <!-- 目录项滚动列表 -->
    <div ref="tocContainerRef" class="flex-1 overflow-y-auto p-1.5 space-y-0.5 scroll-container">
      <template v-if="filteredToc.length > 0">
        <button
          v-for="item in filteredToc"
          :key="item.id"
          :data-toc-id="item.id"
          :class="[
            'w-full text-left py-1 pr-2 rounded text-xs transition duration-150 truncate block cursor-pointer group relative',
            getPaddingClass(item.level),
            activeHeadingId === item.id
              ? 'toc-link-active bg-primary/10 border-l-2 border-primary rounded-l-none font-semibold text-primary'
              : 'hover:bg-muted/60 text-muted-foreground hover:text-foreground',
          ]"
          :title="item.text"
          @click="emit('select', item.id)"
        >
          <span class="truncate block">{{ item.text }}</span>
        </button>
      </template>

      <!-- 空状态 -->
      <div v-else class="text-center py-8 text-xs text-muted-foreground/60">
        {{ searchQuery ? "无匹配章节" : "未检测到文档标题" }}
      </div>
    </div>
  </aside>
</template>
