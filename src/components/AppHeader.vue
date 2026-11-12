<script setup lang="ts">
import { Clock } from "@lucide/vue"

defineProps<{
  currentDocument: { path: string; file_name: string; modified_ms: number | null } | null
  stats: { words: number; characters: number; readingTimeMinutes: number }
  modifiedLabel: string
  progress: number
}>()
</script>

<template>
  <header class="relative shrink-0 select-none z-30">
    <!-- 顶部 2px 极简阅读进度条 -->
    <div class="reading-progress-track">
      <div class="reading-progress-bar" :style="{ width: `${progress}%` }"></div>
    </div>

    <!-- 顶部极简状态栏 -->
    <div
      class="h-7 bg-muted/40 border-b flex items-center justify-between px-3 text-[10px] text-muted-foreground"
    >
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="size-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
        <span class="font-medium text-foreground/80">mzRead</span>
        <span v-if="currentDocument" class="text-muted-foreground/30 font-light">|</span>
        <span
          v-if="currentDocument"
          class="truncate max-w-[240px] md:max-w-[400px] font-mono text-[9px] text-muted-foreground/90"
          :title="currentDocument.path"
        >
          {{ currentDocument.file_name }}
        </span>
      </div>

      <!-- 右侧多维统计信息：字数、阅读时长、修改时间 -->
      <div class="flex items-center gap-2.5 text-[9px]">
        <template v-if="currentDocument">
          <span class="bg-muted px-1.5 py-0.5 rounded-md text-foreground/80 font-mono">
            {{ stats.words.toLocaleString() }} 词 / {{ stats.characters.toLocaleString() }} 字
          </span>
          <span
            class="bg-muted px-1.5 py-0.5 rounded-md text-foreground/80 flex items-center gap-1 font-mono"
          >
            <Clock class="size-2.5 text-muted-foreground" />
            约 {{ stats.readingTimeMinutes }} 分钟
          </span>
          <span class="text-muted-foreground/80 hidden sm:inline">
            最后更新: {{ modifiedLabel }}
          </span>
        </template>
        <span v-else class="text-muted-foreground/60">准备就绪</span>
      </div>
    </div>
  </header>
</template>
