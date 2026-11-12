<script setup lang="ts">
import { ref } from "vue"
import {
  FolderOpen,
  FilePlus,
  RefreshCcw,
  Sun,
  Moon,
  Coffee,
  Edit,
  X,
} from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"

defineProps<{
  isOpen: boolean
  isLoading: boolean
  currentDocument: {
    path: string
    file_name: string
    size_bytes: number
    modified_ms: number | null
  } | null
  fileSizeLabel: string
  lineCount: number
  characterCount: number
  currentTheme: "light" | "dark" | "sepia"
  recentPaths: string[]
  recentFilesMetadata: Record<string, number>
  isEditing: boolean
}>()

const emit = defineEmits<{
  (e: "pickFile"): void
  (e: "newFile"): void
  (e: "refreshFile"): void
  (e: "cycleTheme"): void
  (e: "revealFile"): void
  (e: "openExternal"): void
  (e: "loadFile", path: string): void
  (e: "removeRecent", path: string): void
  (e: "exitApp"): void
}>()

const isRecentMenuOpen = ref(false)
const isContextMenuOpen = ref(false)

function handleLogoClick(event: MouseEvent) {
  event.stopPropagation()
  isRecentMenuOpen.value = !isRecentMenuOpen.value
  isContextMenuOpen.value = false
}

function handleLogoContextMenu() {
  isContextMenuOpen.value = !isContextMenuOpen.value
  isRecentMenuOpen.value = false
}

function closeMenus() {
  isRecentMenuOpen.value = false
  isContextMenuOpen.value = false
}

if (typeof window !== "undefined") {
  window.addEventListener("click", closeMenus)
}

function parsePath(fullPath: string) {
  if (fullPath === "示例内容") {
    return { fileName: "欢迎使用 mzRead.md", parentDir: "内置示例" }
  }
  const clean = fullPath.replace(/\\/g, "/")
  const segments = clean.split("/")
  const fileName = segments.pop() || fullPath
  const parentDir = segments.length ? segments[segments.length - 1] : ""
  return { fileName, parentDir }
}

function formatShortDate(ms: number) {
  const date = new Date(ms)
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")

  if (isToday) {
    return `今天 ${hours}:${minutes}`
  }
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hours}:${minutes}`
}

function selectRecentFile(path: string) {
  closeMenus()
  emit("loadFile", path)
}
</script>

<template>
  <aside
    :class="[
      'flex shrink-0 flex-col bg-muted/20 border-r transition-all duration-300 ease-in-out z-30 h-full max-h-full overflow-hidden select-none',
      isOpen ? 'w-[280px]' : 'w-0 border-r-0',
    ]"
  >
    <!-- 头部 Logo 与基础操作 -->
    <div class="space-y-4 p-4 shrink-0">
      <div class="flex items-center gap-3 relative">
        <div
          class="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-primary via-primary/90 to-primary/60 text-primary-foreground font-black italic tracking-tighter text-sm shadow-md cursor-pointer select-none hover:scale-105 active:scale-95 transition-all duration-200"
          @click="handleLogoClick"
          @contextmenu.prevent="handleLogoContextMenu"
          title="左击查看最近文件，右击退出软件"
        >
          mz
        </div>
        <div class="min-w-0 flex-1">
          <h1 class="text-base font-semibold tracking-tight truncate">mzRead</h1>
          <p class="text-xs text-muted-foreground">本地长文档阅读器</p>
        </div>

        <!-- 最近文档浮窗 (最多8条) -->
        <div
          v-if="isRecentMenuOpen"
          class="absolute left-0 top-11 w-56 rounded-xl border border-border bg-popover p-1 shadow-lg shadow-black/10 z-50 animate-fade-in"
          @click.stop
        >
          <div class="px-2 py-1 text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
            最近打开文档 (最多8条)
          </div>
          <Separator class="my-1" />
          <div v-if="recentPaths.length" class="space-y-0.5 max-h-[220px] overflow-y-auto">
            <button
              v-for="path in recentPaths.slice(0, 8)"
              :key="path"
              class="w-full text-left rounded-lg px-2 py-1 hover:bg-accent hover:text-accent-foreground text-xs text-foreground truncate cursor-pointer transition"
              @click="selectRecentFile(path)"
            >
              {{ parsePath(path).fileName }}
            </button>
          </div>
          <div v-else class="px-2 py-3 text-xs text-muted-foreground text-center">暂无历史记录</div>
        </div>

        <!-- 右击退出菜单 -->
        <div
          v-if="isContextMenuOpen"
          class="absolute left-0 top-11 w-40 rounded-xl border border-border bg-popover p-1 shadow-lg shadow-black/10 z-50 animate-fade-in"
          @click.stop
        >
          <button
            class="w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 hover:bg-destructive/10 hover:text-destructive text-xs text-foreground cursor-pointer transition"
            @click="emit('exitApp')"
          >
            <span>退出软件</span>
            <span class="text-[10px] text-muted-foreground tracking-widest font-mono">⌘Q</span>
          </button>
        </div>
      </div>

      <div class="grid gap-1.5">
        <div class="grid grid-cols-2 gap-1.5">
          <Button
            class="justify-center cursor-pointer text-xs h-9 shadow-sm"
            :disabled="isLoading"
            @click="emit('pickFile')"
          >
            <FolderOpen class="size-3.5" />
            打开文件
          </Button>
          <Button
            class="justify-center cursor-pointer text-xs h-9 shadow-sm"
            :disabled="isLoading"
            @click="emit('newFile')"
          >
            <FilePlus class="size-3.5" />
            新建文件
          </Button>
        </div>
        <div class="grid grid-cols-2 gap-1.5">
          <Button
            variant="outline"
            class="justify-center cursor-pointer text-xs h-9"
            :disabled="!currentDocument || isLoading"
            @click="emit('refreshFile')"
            title="重新载入文件"
          >
            <RefreshCcw class="size-3.5" />
            刷新
          </Button>
          <Button
            variant="outline"
            class="justify-center cursor-pointer text-xs h-9"
            @click="emit('cycleTheme')"
            title="切换浅色 / 深色 / 护眼暖色主题"
          >
            <Sun v-if="currentTheme === 'light'" class="size-3.5" />
            <Moon v-else-if="currentTheme === 'dark'" class="size-3.5" />
            <Coffee v-else class="size-3.5 text-amber-700" />
            <span>{{ currentTheme === "light" ? "浅色" : currentTheme === "dark" ? "深色" : "护眼" }}</span>
          </Button>
        </div>
      </div>
    </div>

    <Separator />

    <!-- 当前文档详情面板 -->
    <div v-if="currentDocument" class="p-4 space-y-3 shrink-0">
      <div class="rounded-xl bg-muted/40 border border-border/40 p-3 space-y-2.5 card-flat">
        <div class="space-y-1">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">当前文档</div>
          <div class="text-xs font-medium text-foreground truncate break-all">{{ currentDocument.file_name }}</div>
        </div>

        <div class="flex flex-wrap gap-1.5">
          <Badge variant="secondary" class="text-[10px] px-1.5 py-0">{{ fileSizeLabel }}</Badge>
          <Badge variant="outline" class="text-[10px] px-1.5 py-0 bg-background/50">{{ lineCount }} 行</Badge>
          <Badge variant="outline" class="text-[10px] px-1.5 py-0 bg-background/50">{{ characterCount }} 字符</Badge>
        </div>

        <div class="grid grid-cols-2 gap-1.5 pt-1 border-t border-border/20">
          <Button
            variant="ghost"
            class="h-7 text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
            :disabled="currentDocument.path === '示例内容'"
            @click="emit('revealFile')"
          >
            定位文件
          </Button>
          <Button
            variant="ghost"
            class="h-7 text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
            :disabled="currentDocument.path === '示例内容'"
            @click="emit('openExternal')"
          >
            外部打开
          </Button>
        </div>
      </div>
    </div>

    <!-- 最近打开列表 (自适应滚动) -->
    <div class="flex-1 flex flex-col min-h-0 overflow-hidden px-4 pb-4">
      <div class="mb-2 flex items-center justify-between shrink-0">
        <h2 class="text-xs font-semibold text-muted-foreground/80">最近打开</h2>
        <Badge variant="outline" class="text-[10px] px-1.5 py-0 bg-background/30 rounded-full">
          {{ recentPaths.length }}
        </Badge>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto rounded-xl border bg-background/30">
        <div v-if="recentPaths.length" class="space-y-1 p-1.5">
          <div
            v-for="path in recentPaths"
            :key="path"
            :class="[
              'group/item flex items-center justify-between rounded-lg p-2 text-left text-xs transition duration-200 cursor-pointer relative border',
              currentDocument?.path === path
                ? isEditing
                  ? 'bg-primary/10 border-primary/30 shadow-sm ring-1 ring-primary/20'
                  : 'bg-muted/60 border-border/60'
                : 'border-transparent hover:bg-accent hover:text-accent-foreground',
            ]"
            @click="emit('loadFile', path)"
          >
            <div
              v-if="currentDocument?.path === path && isEditing"
              class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-primary rounded-r-full"
            ></div>

            <div class="flex-1 min-w-0 pr-6 pl-1 space-y-1">
              <div class="flex items-center gap-1.5">
                <Edit v-if="currentDocument?.path === path && isEditing" class="size-3 text-primary shrink-0" />
                <div
                  :class="[
                    'truncate',
                    currentDocument?.path === path ? 'font-semibold text-foreground' : 'font-medium text-foreground/90',
                  ]"
                >
                  {{ parsePath(path).fileName }}
                </div>
              </div>
              <div class="flex items-center justify-between text-[10px] text-muted-foreground">
                <span class="truncate pr-2">{{ parsePath(path).parentDir }}</span>
                <span
                  v-if="recentFilesMetadata[path]"
                  class="shrink-0 text-[9px] text-muted-foreground/60 font-mono"
                >
                  {{ formatShortDate(recentFilesMetadata[path]) }}
                </span>
              </div>
            </div>

            <button
              class="opacity-0 group-hover/item:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition z-10 absolute right-2"
              title="清除此记录"
              @click.stop="emit('removeRecent', path)"
            >
              <X class="size-3" />
            </button>
          </div>
        </div>
        <div v-else class="flex flex-col items-center justify-center py-10 px-4 text-center">
          <p class="text-xs text-muted-foreground">暂无历史记录</p>
        </div>
      </div>
    </div>
  </aside>
</template>
