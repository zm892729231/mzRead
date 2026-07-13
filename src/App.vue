<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { open } from "@tauri-apps/plugin-dialog"
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener"
import {
  BookOpen,
  ChevronRight,
  FileText,
  FolderOpen,
  List,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCcw,
  Sun,
  X,
  Edit,
  Eye,
  Columns,
  Check,
  Loader2,
  AlertCircle,
} from "@lucide/vue"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { renderMarkdown } from "@/lib/markdown"

interface MarkdownDocument {
  path: string
  file_name: string
  content: string
  size_bytes: number
  modified_ms: number | null
}

const RECENT_KEY = "mzread-recent-files"
const READ_TIMEOUT_MS = 15_000
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")

const sampleMarkdown = `# 欢迎使用 mzRead

这是一个轻量、专注的本地 Markdown 阅读器。

## 核心功能

- **本地极速打开**：打开本地 \`.md\` / \`.markdown\` 文档，极速解析
- **优雅排版渲染**：使用 Tailwind CSS Typography 深度定制的黄金阅读排版
- **大纲视图 (TOC)**：自动解析文档标题，右侧大纲支持平滑滚动定位与可视高亮
- **代码快捷复制**：鼠标悬停代码块时，一键即可复制全部内容
- **安全过滤清理**：对 HTML 输出进行严格的 DOM 净化，保障浏览安全
- **无缝主题切换**：支持浅色 / 深色模式呼吸式切换
- **最近文件管理**：记录您最近阅读的文件，支持路径智能精简与快捷移除

> 提示：点击左侧侧栏的「打开 Markdown」或右下角的「阅读使用指南」开始体验。`

const currentDocument = ref<MarkdownDocument | null>(null)
const rawMarkdown = ref("")
const errorMessage = ref("")
const isLoading = ref(false)
const recentPaths = ref<string[]>([])
const recentFilesMetadata = ref<Record<string, number>>({})
const isDark = ref(systemTheme.matches)
const isSidebarOpen = ref(true)
const isTocOpen = ref(true)
const activeHeadingId = ref<string | null>(null)

const isEditing = ref(false)
const editLayoutMode = ref<'split' | 'edit' | 'preview'>('split')
const saveStatus = ref<'saved' | 'saving' | 'dirty' | 'readonly'>('saved')
const saveError = ref('')
let saveTimeoutId: number | null = null

const renderedMarkdown = computed(() => renderMarkdown(rawMarkdown.value))
const documentTitle = computed(() => currentDocument.value?.file_name ?? "未打开文档")
const characterCount = computed(() => rawMarkdown.value.length)
const lineCount = computed(() => rawMarkdown.value.split(/\r\n|\r|\n/).length)
const fileSizeLabel = computed(() => {
  const size = currentDocument.value?.size_bytes
  if (!size) return "0 B"
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(2)} MB`
})
const modifiedLabel = computed(() => {
  const modified = currentDocument.value?.modified_ms
  return modified ? new Date(modified).toLocaleString() : "未读取"
})

// 正则表达式匹配大纲目录，防止代码块中的 # 干扰
const toc = computed(() => {
  const headings: { id: string; text: string; level: number }[] = []
  if (!rawMarkdown.value) return headings

  const lines = rawMarkdown.value.split(/\r?\n/)
  let headingIndex = 0
  let inCodeBlock = false

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) continue

    const match = line.match(/^(#{1,3})\s+(.+)$/)
    if (match) {
      const level = match[1].length
      let text = match[2].trim()
      // 清理 Markdown 粗体/斜体/代码标记
      text = text
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/`([^`]+)`/g, "$1")

      headings.push({
        id: `heading-${headingIndex++}`,
        text,
        level,
      })
    }
  }
  return headings
})

function sanitizeRecentPaths(paths: unknown[]) {
  const normalized: string[] = []
  for (const item of paths) {
    if (typeof item !== "string") continue
    const path = item.trim()
    if (!path || normalized.includes(path)) continue
    normalized.push(path)
  }
  return normalized
}

function readRecentPathsFromLocalStorage() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]")
    return Array.isArray(parsed) ? sanitizeRecentPaths(parsed) : []
  } catch {
    return []
  }
}

function persistRecentPaths() {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentPaths.value))
  } catch (error) {
    console.warn("最近文件记录保存失败", error)
  }

  invoke("update_recent_paths", { paths: recentPaths.value }).catch((err) => {
    console.warn("同步最近文件到本地配置失败", err)
  })
}

async function readRecentPaths() {
  let paths: string[] = []

  try {
    paths = await invoke<string[]>("recent_paths")
  } catch (error) {
    console.warn("读取本地最近文件记录失败，尝试读取浏览器缓存", error)
  }

  if (!paths.length) {
    paths = readRecentPathsFromLocalStorage()
  }

  recentPaths.value = sanitizeRecentPaths(paths)
  if (recentPaths.value.length) {
    persistRecentPaths()
    void fetchRecentMetadata(recentPaths.value)
  }
}

async function fetchRecentMetadata(paths: string[]) {
  if (!paths.length) return
  try {
    const metadata = await invoke<Record<string, number>>("get_files_metadata", { paths })
    recentFilesMetadata.value = { ...recentFilesMetadata.value, ...metadata }
  } catch (error) {
    console.warn("读取近期文件元数据失败", error)
  }
}

function formatShortDate(ms: number) {
  const date = new Date(ms)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  
  const MM = String(date.getMonth() + 1).padStart(2, '0')
  const DD = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  
  if (isToday) {
    return `今天 ${hh}:${mm}:${ss}`
  }
  return `${date.getFullYear()}/${MM}/${DD} ${hh}:${mm}:${ss}`
}

function rememberPath(path: string) {
  recentPaths.value = sanitizeRecentPaths([path, ...recentPaths.value.filter((item) => item !== path)])
  persistRecentPaths()
}

function removeRecentPath(pathToRemove: string) {
  recentPaths.value = recentPaths.value.filter((p) => p !== pathToRemove)
  persistRecentPaths()
}

// 智能精简路径，突出文件名，提供清晰的父级目录
function parsePath(fullPath: string) {
  if (fullPath === "示例内容") {
    return { fileName: "欢迎使用 mzRead.md", parentDir: "内置示例指南" }
  }
  const sep = fullPath.includes("\\") ? "\\" : "/"
  const parts = fullPath.split(sep)
  const fileName = parts[parts.length - 1]
  const parentDir = parts.slice(0, parts.length - 1).join(sep)
  
  // 简缩父路径，例如：/Users/mzhu/Documents/work -> .../Documents/work
  let shortParent = parentDir
  const parentParts = parentDir.split(sep)
  if (parentParts.length > 3) {
    shortParent = "..." + sep + parentParts.slice(-2).join(sep)
  }
  return { fileName, parentDir: shortParent }
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function timeoutAfter(ms: number) {
  return new Promise<never>((_, reject) => {
    window.setTimeout(() => reject(new Error("读取超时，请检查文件是否过大或磁盘是否响应缓慢")), ms)
  })
}

function withTimeout<T>(promise: Promise<T>, ms = READ_TIMEOUT_MS) {
  return Promise.race([promise, timeoutAfter(ms)])
}

async function forceSaveIfDirty() {
  if (saveTimeoutId) {
    clearTimeout(saveTimeoutId)
    saveTimeoutId = null
  }
  if (saveStatus.value === "dirty") {
    await performSave()
  }
}

async function performSave() {
  if (!currentDocument.value) return
  if (currentDocument.value.path === "示例内容") {
    saveStatus.value = "readonly"
    currentDocument.value.size_bytes = rawMarkdown.value.length
    currentDocument.value.modified_ms = Date.now()
    return
  }

  saveStatus.value = "saving"
  saveError.value = ""
  try {
    const updatedDoc = await invoke<MarkdownDocument>("write_markdown_file", {
      path: currentDocument.value.path,
      content: rawMarkdown.value,
    })
    currentDocument.value = updatedDoc
    saveStatus.value = "saved"
    rememberPath(currentDocument.value.path)
    void fetchRecentMetadata([currentDocument.value.path])
  } catch (err) {
    saveStatus.value = "dirty"
    saveError.value = toErrorMessage(err)
    errorMessage.value = `保存失败: ${saveError.value}`
  }
}

function onEditorInput() {
  if (saveTimeoutId) {
    clearTimeout(saveTimeoutId)
  }
  saveStatus.value = "dirty"
  saveTimeoutId = window.setTimeout(() => {
    void performSave()
  }, 1000)
}

function handleTextareaTab(event: KeyboardEvent) {
  const textarea = event.target as HTMLTextAreaElement
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const value = textarea.value
  rawMarkdown.value = value.substring(0, start) + "  " + value.substring(end)
  textarea.value = rawMarkdown.value
  textarea.selectionStart = textarea.selectionEnd = start + 2
  onEditorInput()
}

async function loadMarkdownFile(path: string) {
  await forceSaveIfDirty()

  if (path === "示例内容") {
    loadSampleDocument()
    return
  }
  isLoading.value = true
  errorMessage.value = ""

  try {
    const document = await withTimeout(invoke<MarkdownDocument>("read_markdown_file", { path }))
    currentDocument.value = document
    rawMarkdown.value = document.content
    rememberPath(document.path)
    
    // 加载文件后重置高亮标题和状态
    activeHeadingId.value = "heading-0"
    saveStatus.value = "saved"
    saveError.value = ""
    isEditing.value = false
  } catch (error) {
    errorMessage.value = toErrorMessage(error)
  } finally {
    isLoading.value = false
  }
}

async function loadFirstOpenedFile(paths: string[]) {
  const markdownPath = paths.find((path) => /\.(md|markdown|mdown|mkd)$/i.test(path))
  if (!markdownPath) return
  await loadMarkdownFile(markdownPath)
}

function loadSampleDocument() {
  currentDocument.value = {
    path: "示例内容",
    file_name: "欢迎使用 mzRead.md",
    content: sampleMarkdown,
    size_bytes: sampleMarkdown.length,
    modified_ms: Date.now(),
  }
  rawMarkdown.value = sampleMarkdown
  activeHeadingId.value = "heading-0"
  saveStatus.value = "saved"
  saveError.value = ""
  isEditing.value = false
}

async function pickMarkdownFile() {
  try {
    const selected = await open({
      title: "打开 Markdown 文档",
      multiple: false,
      filters: [
        {
          name: "Markdown",
          extensions: ["md", "markdown", "mdown", "mkd"],
        },
      ],
      fileAccessMode: "scoped",
    })

    if (!selected || Array.isArray(selected)) return
    await loadMarkdownFile(selected)
  } catch (error) {
    errorMessage.value = toErrorMessage(error)
  }
}

async function refreshCurrentFile() {
  if (!currentDocument.value) return
  await loadMarkdownFile(currentDocument.value.path)
}

async function revealCurrentFile() {
  if (!currentDocument.value || currentDocument.value.path === "示例内容") return
  try {
    await revealItemInDir(currentDocument.value.path)
  } catch (error) {
    errorMessage.value = toErrorMessage(error)
  }
}

async function openCurrentFileExternally() {
  if (!currentDocument.value || currentDocument.value.path === "示例内容") return
  try {
    await openPath(currentDocument.value.path)
  } catch (error) {
    errorMessage.value = toErrorMessage(error)
  }
}

async function handlePreviewClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return

  const link = target.closest("a[href]") as HTMLAnchorElement | null
  if (!link) return

  const href = link.getAttribute("href")
  if (!href || href.startsWith("#")) return

  event.preventDefault()
  try {
    await openUrl(link.href)
  } catch (error) {
    errorMessage.value = toErrorMessage(error)
  }
}

function toggleTheme() {
  isDark.value = !isDark.value
}

// 动态挂载代码块一键复制按钮
const articleRef = ref<HTMLElement | null>(null)

function addCopyButtons() {
  nextTick(() => {
    if (!articleRef.value) return
    const pres = articleRef.value.querySelectorAll("pre")
    pres.forEach((pre) => {
      // 1. 如果已经被包裹在 code-block-wrapper 内部，则跳过
      if (pre.parentElement?.classList.contains("code-block-wrapper")) return

      // 2. 创建 wrapper 容器
      const wrapper = document.createElement("div")
      wrapper.className = "code-block-wrapper relative group"
      
      // 3. 将 wrapper 插入并包裹 pre
      pre.parentNode?.insertBefore(wrapper, pre)
      wrapper.appendChild(pre)
      
      // 4. 创建复制按钮并 append 到 wrapper (这样它就不会随代码块横向滚动而位移)
      const button = document.createElement("button")
      button.className = "copy-code-btn absolute right-3 top-3 size-7 flex items-center justify-center p-0 rounded-lg border border-border bg-background/90 text-muted-foreground transition opacity-0 hover:text-foreground hover:bg-background shadow-xs cursor-pointer z-10"
      
      // 强力用内联样式锁定按钮的尺寸和布局，100% 避免被全局或父级 Flex 样式拉伸
      button.style.width = "28px"
      button.style.height = "28px"
      button.style.minWidth = "28px"
      button.style.minHeight = "28px"
      button.style.maxWidth = "28px"
      button.style.maxHeight = "28px"
      button.style.padding = "0"
      button.style.display = "inline-flex"
      button.style.alignItems = "center"
      button.style.justifyContent = "center"
      button.style.boxSizing = "border-box"
      
      button.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="copy-svg"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      `
      
      button.addEventListener("click", async () => {
        const codeElement = pre.querySelector("code")
        if (codeElement) {
          const codeText = codeElement.innerText
          try {
            await navigator.clipboard.writeText(codeText)
            button.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="check-svg text-emerald-500"><polyline points="20 6 9 17 4 12"/></svg>
            `
            setTimeout(() => {
              button.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="copy-svg"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
              `
            }, 2000)
          } catch (err) {
            console.error("复制失败", err)
          }
        }
      })

      wrapper.appendChild(button)
    })
  })
}

// 提取当前视口最上方的标题，高亮对应的 TOC 链接
function handleScroll() {
  const scrollContainer = document.querySelector(".scroll-container")
  if (!scrollContainer) return

  const headings = document.querySelectorAll("article h1, article h2, article h3")
  if (!headings.length) return

  const containerRect = scrollContainer.getBoundingClientRect()
  let currentActiveId = null

  for (const el of headings) {
    const rect = el.getBoundingClientRect()
    // 当标题滚动到容器顶部 120px 以内时，视为激活
    const relativeTop = rect.top - containerRect.top
    if (relativeTop < 120) {
      currentActiveId = el.id
    } else {
      break
    }
  }

  if (currentActiveId) {
    activeHeadingId.value = currentActiveId
  } else if (headings[0]) {
    activeHeadingId.value = headings[0].id
  }
}

function scrollToHeading(id: string) {
  const el = document.getElementById(id)
  if (el) {
    activeHeadingId.value = id
    el.scrollIntoView({ behavior: "smooth", block: "start" })
  }
}

watch(
  isDark,
  (enabled) => {
    document.documentElement.classList.toggle("dark", enabled)
  },
  { immediate: true },
)

watch(renderedMarkdown, () => {
  addCopyButtons()
  // 重新渲染后重设标题高亮
  nextTick(() => {
    handleScroll()
  })
})

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

function selectRecentFileFromMenu(path: string) {
  loadMarkdownFile(path)
  closeMenus()
}

async function handleExitApp() {
  try {
    await invoke("exit_app")
  } catch (error) {
    console.error("退出应用失败", error)
  }
}

function handleKeyDown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "q") {
    event.preventDefault()
    void handleExitApp()
  }
}

onMounted(() => {
  readRecentPaths()
  invoke<string[]>("opened_files")
    .then(loadFirstOpenedFile)
    .catch((error) => {
      errorMessage.value = toErrorMessage(error)
    })

  listen<string[]>("opened-files", (event) => {
    void loadFirstOpenedFile(event.payload)
  }).catch((error) => {
    errorMessage.value = toErrorMessage(error)
  })

  listen<string>("open-file", (event) => {
    void loadMarkdownFile(event.payload)
  }).catch((error) => {
    errorMessage.value = toErrorMessage(error)
  })

  window.addEventListener("click", closeMenus)
  window.addEventListener("keydown", handleKeyDown)
})

onUnmounted(() => {
  window.removeEventListener("click", closeMenus)
  window.removeEventListener("keydown", handleKeyDown)
})
</script>

<template>
  <div class="flex flex-col h-screen overflow-hidden bg-background text-foreground">
    <!-- 顶部状态栏 -->
    <div class="h-7 shrink-0 bg-muted/40 border-b flex items-center justify-between px-3 text-[10px] text-muted-foreground select-none z-45">
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="size-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
        <span class="font-medium">mzRead v0.2.1</span>
        <span v-if="currentDocument" class="text-muted-foreground/30 font-light">|</span>
        <span v-if="currentDocument" class="truncate max-w-[280px] font-mono text-[9px] text-muted-foreground/90">{{ currentDocument.file_name }}</span>
      </div>
      <div class="flex items-center gap-3.5 text-[9px]">
        <span v-if="currentDocument" class="bg-muted px-1.5 py-0.5 rounded-md">{{ lineCount }} 行</span>
        <span v-if="currentDocument" class="bg-muted px-1.5 py-0.5 rounded-md">{{ characterCount }} 字符</span>
        <span v-if="currentDocument" class="text-muted-foreground/80">编码: UTF-8</span>
      </div>
    </div>

    <main class="flex flex-1 min-h-0 relative">
      <!-- 侧边栏 (加滑动过渡动效) -->
      <aside
        :class="[
          'flex shrink-0 flex-col bg-muted/20 border-r transition-all duration-300 ease-in-out z-30',
          isSidebarOpen ? 'w-[280px]' : 'w-0 overflow-hidden border-r-0',
        ]"
      >
        <!-- 头部 Logo 和基础操作 -->
        <div class="space-y-4 p-4 shrink-0">
          <div class="flex items-center gap-3 relative">
            <!-- 设计独特的 mz 渐变 Logo，绑定左击和右击事件 -->
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
              <p class="text-xs text-muted-foreground">本地 Markdown 阅读器</p>
            </div>

            <!-- 左击 Popover 最近文档菜单 (最多8条) -->
            <div
              v-if="isRecentMenuOpen"
              class="absolute left-0 top-11 w-56 rounded-xl border border-border bg-popover p-1 shadow-lg shadow-black/10 z-50 animate-fade-in"
              @click.stop
            >
              <div class="px-2 py-1 text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">最近打开文档 (最多8条)</div>
              <Separator class="my-1" />
              <div v-if="recentPaths.length" class="space-y-0.5 max-h-[220px] overflow-y-auto">
                <button
                  v-for="path in recentPaths.slice(0, 8)"
                  :key="path"
                  class="w-full text-left rounded-lg px-2 py-1 hover:bg-accent hover:text-accent-foreground text-xs text-foreground truncate cursor-pointer transition"
                  @click="selectRecentFileFromMenu(path)"
                >
                  {{ parsePath(path).fileName }}
                </button>
              </div>
              <div v-else class="px-2 py-3 text-xs text-muted-foreground text-center">
                暂无历史记录
              </div>
            </div>

            <!-- 右击 ContextMenu 菜单 -->
            <div
              v-if="isContextMenuOpen"
              class="absolute left-0 top-11 w-40 rounded-xl border border-border bg-popover p-1 shadow-lg shadow-black/10 z-50 animate-fade-in"
              @click.stop
            >
              <button
                class="w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 hover:bg-destructive/10 hover:text-destructive text-xs text-foreground cursor-pointer transition"
                @click="handleExitApp"
              >
                <span>退出软件</span>
                <span class="text-[10px] text-muted-foreground tracking-widest font-mono">⌘Q</span>
              </button>
            </div>
          </div>

        <div class="grid gap-1.5">
          <Button class="w-full justify-start cursor-pointer text-xs h-9 shadow-sm" :disabled="isLoading" @click="pickMarkdownFile">
            <FolderOpen class="size-3.5" />
            {{ isLoading ? "正在读取..." : "打开 Markdown" }}
          </Button>
          <div class="grid grid-cols-2 gap-1.5">
            <Button
              variant="outline"
              class="justify-center cursor-pointer text-xs h-9"
              :disabled="!currentDocument || isLoading"
              @click="refreshCurrentFile"
            >
              <RefreshCcw class="size-3.5" />
              刷新
            </Button>
            <Button variant="outline" class="justify-center cursor-pointer text-xs h-9" @click="toggleTheme">
              <Sun v-if="isDark" class="size-3.5" />
              <Moon v-else class="size-3.5" />
              {{ isDark ? "浅色" : "深色" }}
            </Button>
          </div>
        </div>
      </div>

      <Separator />

      <!-- 当前文档扁平化信息面板 -->
      <div v-if="currentDocument" class="p-4 space-y-3 shrink-0">
        <div class="rounded-xl bg-muted/40 border border-border/40 p-3 space-y-2.5 card-flat">
          <div class="space-y-1">
            <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">当前文档</div>
            <div class="text-xs font-medium text-foreground truncate break-all">{{ currentDocument.file_name }}</div>
          </div>
          
          <div class="flex flex-wrap gap-1.5">
            <Badge variant="secondary" class="text-[10px] px-1.5 py-0">
              {{ fileSizeLabel }}
            </Badge>
            <Badge variant="outline" class="text-[10px] px-1.5 py-0 bg-background/50">
              {{ lineCount }} 行
            </Badge>
            <Badge variant="outline" class="text-[10px] px-1.5 py-0 bg-background/50">
              {{ characterCount }} 字符
            </Badge>
          </div>
          
          <div class="text-[10px] text-muted-foreground/80">
            修改于：{{ modifiedLabel }}
          </div>

          <div class="grid grid-cols-2 gap-1.5 pt-1 border-t border-border/20">
            <Button
              variant="ghost"
              class="h-7 text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
              :disabled="currentDocument.path === '示例内容'"
              @click="revealCurrentFile"
            >
              定位文件
            </Button>
            <Button
              variant="ghost"
              class="h-7 text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
              :disabled="currentDocument.path === '示例内容'"
              @click="openCurrentFileExternally"
            >
              外部打开
            </Button>
          </div>
        </div>
      </div>

      <!-- 最近打开列表 (高度自适应滚动) -->
      <div class="flex-1 flex flex-col min-h-0 px-4 pb-4">
        <div class="mb-2 flex items-center justify-between shrink-0">
          <h2 class="text-xs font-semibold text-muted-foreground/80">最近打开</h2>
          <Badge variant="outline" class="text-[10px] px-1.5 py-0 bg-background/30 rounded-full">
            {{ recentPaths.length }}
          </Badge>
        </div>
        
        <ScrollArea class="flex-1 rounded-xl border bg-background/30">
          <div v-if="recentPaths.length" class="space-y-1 p-1.5">
            <div
              v-for="path in recentPaths"
              :key="path"
              :class="[
                'group/item flex items-center justify-between rounded-lg p-2 text-left text-xs transition duration-200 cursor-pointer relative border',
                currentDocument?.path === path
                  ? (isEditing 
                      ? 'bg-primary/10 border-primary/30 shadow-sm ring-1 ring-primary/20' 
                      : 'bg-muted/60 border-border/60') 
                  : 'border-transparent hover:bg-accent hover:text-accent-foreground'
              ]"
              @click="loadMarkdownFile(path)"
            >
              <!-- 侧边颜色指示条 (编辑中显示) -->
              <div v-if="currentDocument?.path === path && isEditing" class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-primary rounded-r-full"></div>

              <div class="flex-1 min-w-0 pr-6 pl-1 space-y-1">
                <div class="flex items-center gap-1.5">
                  <Edit v-if="currentDocument?.path === path && isEditing" class="size-3 text-primary shrink-0" />
                  <div :class="['truncate', currentDocument?.path === path ? 'font-semibold text-foreground' : 'font-medium text-foreground/90']">
                    {{ parsePath(path).fileName }}
                  </div>
                </div>
                <div class="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span class="truncate pr-2">{{ parsePath(path).parentDir }}</span>
                  <span v-if="recentFilesMetadata[path]" class="shrink-0 text-[9px] text-muted-foreground/60 font-mono">
                    {{ formatShortDate(recentFilesMetadata[path]) }}
                  </span>
                </div>
              </div>
              <!-- 快捷清除记录按钮 -->
              <button
                class="opacity-0 group-hover/item:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition z-10 absolute right-2"
                title="清除此记录"
                @click.stop="removeRecentPath(path)"
              >
                <X class="size-3" />
              </button>
            </div>
          </div>
          <div v-else class="flex flex-col items-center justify-center py-10 px-4 text-center">
            <p class="text-xs text-muted-foreground">暂无历史记录</p>
          </div>
        </ScrollArea>
      </div>
    </aside>

    <!-- 右侧主预览视口 -->
    <section class="flex flex-1 min-w-0 flex-col h-full relative">
      <!-- 顶部毛玻璃导航 Header -->
      <header class="flex h-14 shrink-0 items-center justify-between border-b px-4 bg-background/80 backdrop-blur-md sticky top-0 z-20">
        <div class="flex items-center gap-2 min-w-0">
          <!-- 侧边栏开关 -->
          <Button
            variant="ghost"
            size="icon"
            class="size-8 cursor-pointer rounded-lg text-muted-foreground hover:text-foreground"
            @click="isSidebarOpen = !isSidebarOpen"
          >
            <PanelLeftClose v-if="isSidebarOpen" class="size-4" />
            <PanelLeftOpen v-else class="size-4" />
          </Button>
          <Separator orientation="vertical" class="h-4" />
          <div class="flex items-center gap-1.5 min-w-0">
            <FileText v-if="currentDocument" class="size-3.5 text-muted-foreground shrink-0" />
            <h2 class="text-sm font-semibold truncate">
              {{ currentDocument ? documentTitle : "mzRead" }}
            </h2>
          </div>
        </div>

        <div class="flex items-center gap-1">
          <!-- 保存状态指示 -->
          <div v-if="isEditing" class="flex items-center gap-1.5 mr-2 px-2 h-7 rounded-md bg-muted/50 text-[10px] select-none transition-all duration-300">
            <template v-if="saveStatus === 'saved'">
              <Check class="size-3 text-emerald-500" />
              <span class="text-muted-foreground">已保存</span>
            </template>
            <template v-else-if="saveStatus === 'saving'">
              <Loader2 class="size-3 text-primary animate-spin" />
              <span class="text-muted-foreground">保存中...</span>
            </template>
            <template v-else-if="saveStatus === 'dirty'">
              <span class="size-1.5 rounded-full bg-amber-500"></span>
              <span class="text-muted-foreground">未保存</span>
            </template>
            <template v-else-if="saveStatus === 'readonly'">
              <AlertCircle class="size-3 text-muted-foreground" />
              <span class="text-muted-foreground">示例预览(只读)</span>
            </template>
          </div>

          <!-- 布局切换按钮组 (仅在编辑状态) -->
          <div v-if="isEditing" class="flex items-center bg-muted/50 rounded-lg p-0.5 mr-2 animate-fade-in">
            <button
              :class="['p-1.5 rounded-md cursor-pointer transition', editLayoutMode === 'split' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground']"
              @click="editLayoutMode = 'split'"
              title="双栏预览"
            >
              <Columns class="size-3.5" />
            </button>
            <button
              :class="['p-1.5 rounded-md cursor-pointer transition', editLayoutMode === 'edit' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground']"
              @click="editLayoutMode = 'edit'"
              title="仅展示编辑"
            >
              <Edit class="size-3.5" />
            </button>
            <button
              :class="['p-1.5 rounded-md cursor-pointer transition', editLayoutMode === 'preview' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground']"
              @click="editLayoutMode = 'preview'"
              title="只看预览"
            >
              <Eye class="size-3.5" />
            </button>
          </div>

          <!-- 编辑开关 -->
          <Button
            v-if="currentDocument"
            variant="ghost"
            size="icon"
            :class="['size-8 cursor-pointer rounded-lg mr-1 transition-colors', isEditing ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground']"
            @click="isEditing = !isEditing"
            title="开启/关闭编辑"
          >
            <Edit class="size-4" />
          </Button>

          <!-- 大纲开关 -->
          <Button
            v-if="currentDocument && (!isEditing || editLayoutMode === 'preview')"
            variant="ghost"
            size="icon"
            :class="['size-8 cursor-pointer rounded-lg transition-colors', isTocOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground']"
            @click="isTocOpen = !isTocOpen"
            title="切换文档大纲"
          >
            <List class="size-4" />
          </Button>
        </div>
      </header>

      <!-- 异常横幅 -->
      <div v-if="errorMessage" class="border-b border-destructive/20 bg-destructive/5 px-4 py-2.5 text-xs text-destructive flex items-center justify-between shrink-0">
        <span>{{ errorMessage }}</span>
        <button class="text-muted-foreground hover:text-foreground" @click="errorMessage = ''">
          <X class="size-3.5" />
        </button>
      </div>

      <!-- 加载蒙版 -->
      <div v-if="isLoading" class="absolute inset-0 z-40 bg-background/60 backdrop-blur-xs flex items-center justify-center">
        <div class="flex flex-col items-center gap-3">
          <RefreshCcw class="size-6 text-primary animate-spin" />
          <span class="text-xs text-muted-foreground">正在加载文档内容...</span>
        </div>
      </div>

      <!-- 核心内容区域 (欢迎页 OR 阅读大纲布局) -->
      <div class="flex flex-1 min-h-0 overflow-hidden">
        <!-- A. 欢迎首屏 (当没有打开文件时) -->
        <div v-if="!currentDocument" class="flex-1 flex flex-col items-center justify-center p-6 bg-radial from-background via-background to-muted/10 overflow-y-auto">
          <div class="max-w-[480px] w-full text-center space-y-8 animate-fade-in">
            <div class="space-y-3">
              <div class="mx-auto flex size-16 items-center justify-center overflow-hidden rounded-2xl shadow-lg shadow-primary/10">
                <img src="/logo.png" alt="mzRead logo" class="size-full object-cover" />
              </div>
              <h1 class="text-2xl font-bold tracking-tight bg-clip-text text-foreground">欢迎使用 mzRead</h1>
              <p class="text-xs text-muted-foreground max-w-sm mx-auto">
                专注阅读的本地 Markdown 阅读器。拖入或直接打开您的 Markdown 文件，享受舒适的排版阅读体验。
              </p>
            </div>

            <!-- 操作大卡片 -->
            <div class="grid gap-3 p-1 bg-muted/20 border border-border/40 rounded-2xl shadow-sm">
              <button
                class="flex items-center justify-between p-4 rounded-xl bg-background hover:bg-muted/40 border border-border/50 text-left transition duration-200 cursor-pointer shadow-xs group"
                @click="pickMarkdownFile"
              >
                <div class="flex items-center gap-3">
                  <div class="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <FolderOpen class="size-4.5" />
                  </div>
                  <div>
                    <div class="text-xs font-semibold">打开 Markdown 文档</div>
                    <div class="text-[10px] text-muted-foreground mt-0.5">选择磁盘中的 .md 或 .markdown 文件</div>
                  </div>
                </div>
                <ChevronRight class="size-4 text-muted-foreground group-hover:translate-x-0.5 transition" />
              </button>

              <button
                class="flex items-center justify-between p-4 rounded-xl bg-background hover:bg-muted/40 border border-border/50 text-left transition duration-200 cursor-pointer shadow-xs group"
                @click="loadSampleDocument"
              >
                <div class="flex items-center gap-3">
                  <div class="flex size-9 items-center justify-center rounded-lg bg-secondary text-foreground">
                    <BookOpen class="size-4.5" />
                  </div>
                  <div>
                    <div class="text-xs font-semibold">阅读使用指南</div>
                    <div class="text-[10px] text-muted-foreground mt-0.5">查看 mzRead 内置的高清排版与渲染示例</div>
                  </div>
                </div>
                <ChevronRight class="size-4 text-muted-foreground group-hover:translate-x-0.5 transition" />
              </button>
            </div>

            <!-- 快捷功能提示 -->
            <div class="grid grid-cols-2 gap-4 text-left">
              <div class="space-y-1">
                <h3 class="text-xs font-semibold text-foreground">💡 极速排版</h3>
                <p class="text-[10px] text-muted-foreground leading-relaxed">
                  内置符合人类阅读习惯的字宽与行高比例，支持代码高亮与公式。
                </p>
              </div>
              <div class="space-y-1">
                <h3 class="text-xs font-semibold text-foreground">🎯 大纲平滑定位</h3>
                <p class="text-[10px] text-muted-foreground leading-relaxed">
                  高精度解析目录标题，点击直接跳转，滚动实时追踪可视状态。
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- B. Markdown 阅读区 & TOC 目录双栏 -->
        <template v-else>
          <!-- 1. 编辑器视图 (仅在 isEditing 且 layout 是 split 或 edit 时显示) -->
          <div 
            v-if="isEditing && (editLayoutMode === 'split' || editLayoutMode === 'edit')" 
            :class="['flex flex-col h-full', editLayoutMode === 'split' ? 'w-1/2 border-r border-border/50 bg-background' : 'w-full']"
          >
            <textarea
              class="flex-1 w-full p-6 md:p-10 resize-none font-mono text-sm leading-relaxed bg-transparent text-foreground focus:outline-none scroll-container"
              v-model="rawMarkdown"
              @input="onEditorInput"
              @keydown.tab.prevent="handleTextareaTab"
              placeholder="开始编写 Markdown..."
              spellcheck="false"
            ></textarea>
          </div>

          <!-- 2. 阅读主视图 -->
          <div 
            v-if="!isEditing || editLayoutMode === 'split' || editLayoutMode === 'preview'"
            :class="['overflow-y-auto scroll-container select-text', (!isEditing || editLayoutMode === 'preview') ? 'flex-1' : 'w-1/2 bg-muted/5']" 
            @scroll="handleScroll"
          >
            <div class="max-w-none px-6 md:px-12 py-10 w-full">
              <article
                ref="articleRef"
                class="prose prose-neutral max-w-none dark:prose-invert prose-headings:scroll-mt-20 prose-pre:rounded-xl prose-pre:border prose-pre:bg-muted/60 prose-pre:text-foreground prose-img:rounded-xl"
                @click="handlePreviewClick"
                v-html="renderedMarkdown"
              />
            </div>
          </div>

          <!-- 3. 右侧文档大纲 (TOC) -->
          <aside
            v-if="!isEditing || editLayoutMode === 'preview'"
            :class="[
              'shrink-0 border-l bg-muted/10 flex flex-col transition-all duration-300 ease-in-out',
              isTocOpen ? 'w-[220px]' : 'w-0 overflow-hidden border-l-0',
            ]"
          >
            <div class="p-3 border-b flex items-center justify-between shrink-0">
              <div class="text-xs font-semibold text-muted-foreground">大纲目录</div>
              <Badge variant="outline" class="text-[10px] px-1 rounded-full py-0">
                {{ toc.length }}
              </Badge>
            </div>
            
            <ScrollArea class="flex-1">
              <div v-if="toc.length" class="p-3 space-y-1.5">
                <button
                  v-for="item in toc"
                  :key="item.id"
                  :class="[
                    'w-full text-left rounded-md px-2.5 py-1.5 transition-all duration-200 text-xs truncate cursor-pointer hover:bg-accent/50',
                    item.level === 1 ? 'font-medium pl-2.5 text-foreground' : '',
                    item.level === 2 ? 'pl-5 text-muted-foreground/90' : '',
                    item.level === 3 ? 'pl-7.5 text-muted-foreground/75 text-[11px]' : '',
                    activeHeadingId === item.id ? 'toc-link-active bg-primary/5 border-l-2 border-primary rounded-l-none' : '',
                  ]"
                  @click="scrollToHeading(item.id)"
                  :title="item.text"
                >
                  {{ item.text }}
                </button>
              </div>
              <p v-else class="p-4 text-xs text-muted-foreground text-center">
                文档中没有发现标题
              </p>
            </ScrollArea>
          </aside>
        </template>
      </div>
    </section>
  </main>
</div>
</template>

<style>
/* 补充 Tailwind v4 未提供或更细节的微调排版 */
.prose {
  font-variant-ligatures: common-ligatures;
}
.prose pre {
  font-family: Menlo, Monaco, Consolas, "Fira Code", monospace;
  font-size: 0.85em;
  line-height: 1.6;
}
.prose p {
  text-align: justify;
  line-height: 1.75;
}
/* 自定义列表样式对齐 */
.prose ul, .prose ol {
  padding-left: 1.25em;
}
/* 解决 Lucide 图标的垂直居中对齐 */
.size-4\.5 {
  width: 1.125rem;
  height: 1.125rem;
}
.size-3\.5 {
  width: 0.875rem;
  height: 0.875rem;
}
</style>
