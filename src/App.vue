<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { open, save } from "@tauri-apps/plugin-dialog"
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
  Search,
  ChevronUp,
  ChevronDown,
  FilePlus,
  ArrowUp,
  CaseSensitive,
  Coffee,
  Maximize2,
  Minimize2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Clock,
  Type,
} from "@lucide/vue"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { renderMarkdown } from "@/lib/markdown"

interface MarkdownDocument {
  path: string
  file_name: string
  content: string
  size_bytes: number
  modified_ms: number | null
}

interface TocItem {
  id: string
  text: string
  level: number
}

interface EditorMatch {
  start: number
  end: number
}

const RECENT_KEY = "mzread-recent-files"
const SCROLL_POS_KEY = "mzread-scroll-positions"
const THEME_KEY = "mzread-theme"
const WIDE_MODE_KEY = "mzread-wide-mode"
const FONT_SIZE_KEY = "mzread-font-size"
const READ_TIMEOUT_MS = 15_000
const systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)")

const sampleMarkdown = `# 欢迎使用 mzRead

这是一个轻量、专注、现代化的本地 Markdown 与长文档阅读器。

## 核心功能与亮点

- **本地极速打开**：打开本地 \`.md\` / \`.markdown\` 文档，极速解析
- **页内快速搜索 (⌘F)**：悬浮毛玻璃搜索栏，支持实时计数、区分大小写 (Aa)、快捷键上下跳转与居中定位
- **大纲目录 (TOC) 联动**：支持 H1~H4 层级，配备目录快速筛选过滤与滚动实时追踪 (ScrollSpy)
- **多档阅读主题**：支持浅色 (Light)、深色 (Dark) 以及护眼羊皮纸 (Sepia) 暖色主题
- **阅读宽度与字号自由调节**：支持一键切换宽屏排版，支持 \`⌘+\` / \`⌘-\` / \`⌘0\` 字号无级调节
- **阅读进度条与回到顶部**：顶部 2px 极简阅读进度条，滚动一屏后浮现丝滑回到顶部按钮
- **代码块语言标签与一键复制**：右上角自动识别语言（如 \`ts\`、\`rust\`、\`bash\`），悬停一键快速复制
- **图片点击放大 (Lightbox)**：支持全屏高清沉浸式预览图片与无级缩放
- **阅读位置记忆**：自动记忆并恢复每篇文档上次的阅读滚动位置
- **外部文件改动热重载 (Live Reload)**：外部编辑器修改保存后，无需手动刷新，自动热重载正文

### 代码演示示例

\`\`\`rust
fn main() {
    println!("Hello, mzRead!");
}
\`\`\`

\`\`\`typescript
interface ReaderConfig {
  theme: "light" | "dark" | "sepia";
  fontSize: number;
  wideMode: boolean;
}
\`\`\`

> 提示：点击左侧侧栏的「打开 Markdown」或右下角的「阅读使用指南」即可开始体验。`

// 文档与编辑器状态
const currentDocument = ref<MarkdownDocument | null>(null)
const rawMarkdown = ref("")
const errorMessage = ref("")
const isLoading = ref(false)
const recentPaths = ref<string[]>([])
const recentFilesMetadata = ref<Record<string, number>>({})

// 界面布局与侧栏
const isSidebarOpen = ref(true)
const isTocOpen = ref(true)
const activeHeadingId = ref<string | null>(null)
const isEditing = ref(false)
const editLayoutMode = ref<'split' | 'edit' | 'preview'>('split')
const saveStatus = ref<'saved' | 'saving' | 'dirty' | 'readonly'>('saved')
const saveError = ref('')
let saveTimeoutId: number | null = null

// 主题模式：'light' | 'dark' | 'sepia'
type ThemeMode = 'light' | 'dark' | 'sepia'
const initialTheme = (localStorage.getItem(THEME_KEY) as ThemeMode) || (systemDarkQuery.matches ? 'dark' : 'light')
const currentTheme = ref<ThemeMode>(initialTheme)

// 排版模式：宽屏与字号
const isWideMode = ref(localStorage.getItem(WIDE_MODE_KEY) === 'true')
const fontSize = ref(Number(localStorage.getItem(FONT_SIZE_KEY)) || 16)

// 阅读进度与回到顶部
const readingProgress = ref(0)
const showBackToTop = ref(false)
const previewContainerRef = ref<HTMLElement | null>(null)
const articleRef = ref<HTMLElement | null>(null)

// 外部文件更新通知 (Live Reload)
const liveReloadNotice = ref("")
let noticeTimeoutId: number | null = null
let fileWatchIntervalId: number | null = null

// TOC 目录筛选
const tocSearchQuery = ref("")

// 搜索状态 (Cmd/Ctrl + F)
const showSearch = ref(false)
const searchQuery = ref("")
const isCaseSensitive = ref(false)
const searchMatches = ref<HTMLElement[]>([])
const editorMatches = ref<EditorMatch[]>([])
const currentMatchIndex = ref(-1)
const searchInputRef = ref<HTMLInputElement | null>(null)

// 图片 Lightbox
const lightboxImage = ref<{ src: string; alt: string } | null>(null)
const lightboxScale = ref(1)
const lightboxRotate = ref(0)

// 顶部 / 底部菜单
const isRecentMenuOpen = ref(false)
const isContextMenuOpen = ref(false)

// ----------------------------------------------------
// 计算属性与统计信息
// ----------------------------------------------------
const renderedMarkdown = computed(() => renderMarkdown(rawMarkdown.value))
const documentTitle = computed(() => currentDocument.value?.file_name ?? "未打开文档")
const characterCount = computed(() => rawMarkdown.value.length)
const lineCount = computed(() => rawMarkdown.value.split(/\r\n|\r|\n/).length)

// 中英文字数与阅读时长统计
const documentStats = computed(() => {
  const text = rawMarkdown.value || ""
  if (!text) return { words: 0, characters: 0, readingTimeMinutes: 0 }
  // 中文字符数
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  // 英文/数字单词数
  const englishWords = (text.replace(/[\u4e00-\u9fa5]/g, " ").match(/[a-zA-Z0-9_-]+/g) || []).length
  const totalWords = chineseChars + englishWords
  const readingTimeMinutes = Math.max(1, Math.ceil(totalWords / 350))
  return {
    words: totalWords,
    characters: text.length,
    readingTimeMinutes,
  }
})

const fileSizeLabel = computed(() => {
  const size = currentDocument.value?.size_bytes
  if (!size) return "0 B"
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(2)} MB`
})

const modifiedLabel = computed(() => {
  const modified = currentDocument.value?.modified_ms
  if (!modified) return "未读取"
  return formatShortDate(modified)
})

// 正则表达式匹配大纲目录（支持 H1~H4），防代码块干涉
const toc = computed<TocItem[]>(() => {
  const headings: TocItem[] = []
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

    const match = line.match(/^(#{1,4})\s+(.+)$/)
    if (match) {
      const level = match[1].length
      let text = match[2].trim()
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

// 根据搜索关键词过滤的 TOC
const filteredToc = computed(() => {
  if (!tocSearchQuery.value.trim()) return toc.value
  const q = tocSearchQuery.value.toLowerCase().trim()
  return toc.value.filter((item) => item.text.toLowerCase().includes(q))
})

// ----------------------------------------------------
// 主题控制
// ----------------------------------------------------
watch(
  currentTheme,
  (theme) => {
    document.documentElement.classList.remove("dark", "sepia")
    if (theme === "dark") {
      document.documentElement.classList.add("dark")
    } else if (theme === "sepia") {
      document.documentElement.classList.add("sepia")
    }
    localStorage.setItem(THEME_KEY, theme)
  },
  { immediate: true },
)

function cycleTheme() {
  if (currentTheme.value === "light") {
    currentTheme.value = "dark"
  } else if (currentTheme.value === "dark") {
    currentTheme.value = "sepia"
  } else {
    currentTheme.value = "light"
  }
}

// ----------------------------------------------------
// 字号与宽屏排版控制
// ----------------------------------------------------
function toggleWideMode() {
  isWideMode.value = !isWideMode.value
  localStorage.setItem(WIDE_MODE_KEY, String(isWideMode.value))
}

function zoomInFont() {
  fontSize.value = Math.min(26, fontSize.value + 1)
  localStorage.setItem(FONT_SIZE_KEY, String(fontSize.value))
}

function zoomOutFont() {
  fontSize.value = Math.max(12, fontSize.value - 1)
  localStorage.setItem(FONT_SIZE_KEY, String(fontSize.value))
}

function resetFontSize() {
  fontSize.value = 16
  localStorage.setItem(FONT_SIZE_KEY, "16")
}

// ----------------------------------------------------
// 阅读位置记忆 (Scroll Position Memory)
// ----------------------------------------------------
function getSavedScrollPosition(path: string): number {
  try {
    const map = JSON.parse(localStorage.getItem(SCROLL_POS_KEY) || "{}")
    return typeof map[path] === "number" ? map[path] : 0
  } catch {
    return 0
  }
}

let scrollDebounceTimer: number | null = null
function recordScrollPosition(path: string, top: number) {
  if (!path || path === "示例内容") return
  if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer)
  scrollDebounceTimer = window.setTimeout(() => {
    try {
      const map = JSON.parse(localStorage.getItem(SCROLL_POS_KEY) || "{}")
      map[path] = top
      localStorage.setItem(SCROLL_POS_KEY, JSON.stringify(map))
    } catch (e) {
      console.warn("保存滚动位置失败", e)
    }
  }, 300)
}

function restoreScrollPosition(path: string) {
  const targetTop = getSavedScrollPosition(path)
  nextTick(() => {
    setTimeout(() => {
      if (previewContainerRef.value && targetTop > 0) {
        previewContainerRef.value.scrollTo({ top: targetTop, behavior: "instant" })
      }
    }, 60)
  })
}

// ----------------------------------------------------
// 外部文件更新检测 (Live Reload)
// ----------------------------------------------------
function notifyLiveReload(msg: string) {
  liveReloadNotice.value = msg
  if (noticeTimeoutId) clearTimeout(noticeTimeoutId)
  noticeTimeoutId = window.setTimeout(() => {
    liveReloadNotice.value = ""
  }, 3500)
}

async function checkFileExternalUpdate() {
  if (!currentDocument.value || currentDocument.value.path === "示例内容") return
  if (isEditing.value && saveStatus.value === "dirty") return // 编辑中不覆盖未保存修改
  if (isLoading.value) return

  try {
    const metadata = await invoke<Record<string, number>>("get_files_metadata", {
      paths: [currentDocument.value.path],
    })
    const latestMs = metadata[currentDocument.value.path]
    if (latestMs && currentDocument.value.modified_ms && latestMs > currentDocument.value.modified_ms) {
      const currentScroll = previewContainerRef.value?.scrollTop || 0
      const updatedDoc = await invoke<MarkdownDocument>("read_markdown_file", {
        path: currentDocument.value.path,
      })
      if (updatedDoc.content !== rawMarkdown.value) {
        currentDocument.value = updatedDoc
        rawMarkdown.value = updatedDoc.content
        notifyLiveReload("检测到外部改动，文档已自动热重载")
        nextTick(() => {
          if (previewContainerRef.value && currentScroll > 0) {
            previewContainerRef.value.scrollTop = currentScroll
          }
          if (showSearch.value && searchQuery.value) {
            performSearch()
          }
        })
      } else {
        currentDocument.value.modified_ms = latestMs
      }
    }
  } catch {
    // 静默忽略轮询错误
  }
}

// ----------------------------------------------------
// 滚动追踪 (ScrollSpy, 进度条, 回到顶部, 记忆)
// ----------------------------------------------------
function handleScroll() {
  const container = previewContainerRef.value
  if (!container) return

  const { scrollTop, scrollHeight, clientHeight } = container
  showBackToTop.value = scrollTop > 320

  const maxScroll = scrollHeight - clientHeight
  readingProgress.value = maxScroll > 0 ? Math.min(100, Math.max(0, (scrollTop / maxScroll) * 100)) : 0

  if (currentDocument.value) {
    recordScrollPosition(currentDocument.value.path, scrollTop)
  }

  // TOC ScrollSpy
  const headings = container.querySelectorAll("article h1, article h2, article h3, article h4")
  if (!headings.length) return

  const containerRect = container.getBoundingClientRect()
  let currentActiveId: string | null = null

  for (const el of Array.from(headings)) {
    const rect = el.getBoundingClientRect()
    const relativeTop = rect.top - containerRect.top
    if (relativeTop < 130) {
      currentActiveId = el.id
    } else {
      break
    }
  }

  if (currentActiveId) {
    activeHeadingId.value = currentActiveId
  } else if (headings[0]) {
    activeHeadingId.value = (headings[0] as HTMLElement).id
  }

  // 联动 TOC 目录项跟随滚动
  if (activeHeadingId.value) {
    const activeTocBtn = document.querySelector(`[data-toc-id="${activeHeadingId.value}"]`) as HTMLElement | null
    if (activeTocBtn) {
      activeTocBtn.scrollIntoView({ behavior: "smooth", block: "nearest" })
    }
  }
}

function scrollToTop() {
  previewContainerRef.value?.scrollTo({ top: 0, behavior: "smooth" })
}

function scrollToHeading(id: string) {
  const el = document.getElementById(id)
  if (el) {
    activeHeadingId.value = id
    el.scrollIntoView({ behavior: "smooth", block: "start" })
  }
}

// ----------------------------------------------------
// 搜索相关核心实现 (Cmd/Ctrl + F)
// ----------------------------------------------------
function clearHighlights(element: HTMLElement) {
  const marks = element.querySelectorAll("mark.search-highlight")
  marks.forEach((mark) => {
    const parent = mark.parentNode
    if (parent) {
      parent.replaceChild(document.createTextNode(mark.textContent || ""), mark)
      parent.normalize()
    }
  })
}

function highlightDOM(element: HTMLElement, query: string, caseSensitive: boolean): HTMLElement[] {
  const matches: HTMLElement[] = []
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const regex = new RegExp(escapedQuery, caseSensitive ? "g" : "gi")

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue || ""
      let match: RegExpExecArray | null
      const parent = node.parentNode
      if (!parent || parent.nodeName === "SCRIPT" || parent.nodeName === "STYLE") return

      if (
        parent instanceof HTMLElement &&
        (parent.classList.contains("copy-code-btn") ||
          parent.classList.contains("code-lang-badge") ||
          parent.closest(".copy-code-btn") ||
          parent.closest(".code-lang-badge"))
      ) {
        return
      }

      if (regex.test(text)) {
        regex.lastIndex = 0
        const fragment = document.createDocumentFragment()
        let lastIndex = 0

        while ((match = regex.exec(text)) !== null) {
          const before = text.substring(lastIndex, match.index)
          if (before) fragment.appendChild(document.createTextNode(before))

          const mark = document.createElement("mark")
          mark.className = "search-highlight"
          mark.textContent = match[0]
          fragment.appendChild(mark)
          matches.push(mark)

          lastIndex = regex.lastIndex
        }

        const after = text.substring(lastIndex)
        if (after) fragment.appendChild(document.createTextNode(after))

        parent.replaceChild(fragment, node)
      }
    } else {
      const children = Array.from(node.childNodes)
      for (const child of children) {
        walk(child)
      }
    }
  }

  walk(element)
  return matches
}

function performSearch() {
  if (articleRef.value) {
    clearHighlights(articleRef.value)
  }

  searchMatches.value = []
  editorMatches.value = []

  const query = searchQuery.value.trim()
  if (!query) {
    currentMatchIndex.value = -1
    return
  }

  // 预览区 DOM 文本搜索
  if (articleRef.value) {
    searchMatches.value = highlightDOM(articleRef.value, query, isCaseSensitive.value)
  }

  // 编辑器区域源码搜索
  if (rawMarkdown.value) {
    const text = rawMarkdown.value
    const searchTarget = isCaseSensitive.value ? text : text.toLowerCase()
    const searchNeedle = isCaseSensitive.value ? query : query.toLowerCase()
    let pos = searchTarget.indexOf(searchNeedle)
    const matchesList: EditorMatch[] = []
    while (pos !== -1) {
      matchesList.push({
        start: pos,
        end: pos + query.length,
      })
      pos = searchTarget.indexOf(searchNeedle, pos + 1)
    }
    editorMatches.value = matchesList
  }

  const total = Math.max(searchMatches.value.length, editorMatches.value.length)
  if (total > 0) {
    if (currentMatchIndex.value < 0 || currentMatchIndex.value >= total) {
      currentMatchIndex.value = 0
    }
    highlightCurrentMatch()
  } else {
    currentMatchIndex.value = -1
  }
}

function highlightCurrentMatch() {
  searchMatches.value.forEach((mark, idx) => {
    if (idx === currentMatchIndex.value) {
      mark.className = "search-highlight search-highlight-current"
      mark.scrollIntoView({ behavior: "smooth", block: "center" })
    } else {
      mark.className = "search-highlight"
    }
  })

  // 如果处于纯编辑或分屏编辑中，同时选中文本域
  if (isEditing.value && (editLayoutMode.value === "split" || editLayoutMode.value === "edit")) {
    if (editorMatches.value.length > 0 && currentMatchIndex.value >= 0 && currentMatchIndex.value < editorMatches.value.length) {
      const match = editorMatches.value[currentMatchIndex.value]
      const textarea = document.querySelector("textarea")
      if (textarea) {
        textarea.focus()
        textarea.setSelectionRange(match.start, match.end)

        const textBefore = textarea.value.substring(0, match.start)
        const lineCountBefore = textBefore.split("\n").length
        const lineHeight = 22
        const scrollTarget = (lineCountBefore - 5) * lineHeight
        textarea.scrollTo({
          top: Math.max(0, scrollTarget),
          behavior: "smooth",
        })
      }
    }
  }
}

function handleSearchNext() {
  const total = Math.max(searchMatches.value.length, editorMatches.value.length)
  if (total === 0) return
  currentMatchIndex.value = (currentMatchIndex.value + 1) % total
  highlightCurrentMatch()
}

function handleSearchPrev() {
  const total = Math.max(searchMatches.value.length, editorMatches.value.length)
  if (total === 0) return
  currentMatchIndex.value = (currentMatchIndex.value - 1 + total) % total
  highlightCurrentMatch()
}

function toggleCaseSensitive() {
  isCaseSensitive.value = !isCaseSensitive.value
  performSearch()
}

function closeSearch() {
  showSearch.value = false
  searchQuery.value = ""
  if (articleRef.value) {
    clearHighlights(articleRef.value)
  }
  searchMatches.value = []
  editorMatches.value = []
  currentMatchIndex.value = -1
}

function toggleSearch() {
  if (showSearch.value) {
    closeSearch()
  } else {
    showSearch.value = true
    nextTick(() => {
      searchInputRef.value?.focus()
      searchInputRef.value?.select()
      if (searchQuery.value) {
        performSearch()
      }
    })
  }
}

watch([searchQuery, renderedMarkdown], () => {
  if (showSearch.value) {
    nextTick(() => {
      performSearch()
    })
  }
})

// ----------------------------------------------------
// 代码块一键复制与语言标签增强
// ----------------------------------------------------
function addCodeEnhancements() {
  nextTick(() => {
    if (!articleRef.value) return
    const pres = articleRef.value.querySelectorAll("pre")
    pres.forEach((pre) => {
      if (pre.parentElement?.classList.contains("code-block-wrapper")) return

      const wrapper = document.createElement("div")
      wrapper.className = "code-block-wrapper relative group"
      pre.parentNode?.insertBefore(wrapper, pre)
      wrapper.appendChild(pre)

      // 解析语言标签
      const codeElement = pre.querySelector("code")
      const classAttr = codeElement?.getAttribute("class") || ""
      const langMatch = classAttr.match(/language-([a-zA-Z0-9_+-]+)/)
      if (langMatch && langMatch[1]) {
        const langName = langMatch[1].toUpperCase()
        const langBadge = document.createElement("span")
        langBadge.className =
          "code-lang-badge absolute right-11 top-2.5 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-muted/80 text-muted-foreground uppercase tracking-wider select-none opacity-60 group-hover:opacity-100 transition pointer-events-none"
        langBadge.textContent = langName
        wrapper.appendChild(langBadge)
      }

      // 复制按钮
      const button = document.createElement("button")
      button.className =
        "copy-code-btn absolute right-3 top-2.5 size-7 flex items-center justify-center p-0 rounded-lg border border-border bg-background/90 text-muted-foreground transition opacity-0 hover:text-foreground hover:bg-background shadow-xs cursor-pointer z-10"

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

// ----------------------------------------------------
// 图片预览放大 (Lightbox)
// ----------------------------------------------------
function openLightbox(src: string, alt: string) {
  lightboxImage.value = { src, alt }
  lightboxScale.value = 1
  lightboxRotate.value = 0
}

function closeLightbox() {
  lightboxImage.value = null
  lightboxScale.value = 1
  lightboxRotate.value = 0
}

function zoomInLightbox() {
  lightboxScale.value = Math.min(3, lightboxScale.value + 0.25)
}

function zoomOutLightbox() {
  lightboxScale.value = Math.max(0.5, lightboxScale.value - 0.25)
}

function rotateLightbox() {
  lightboxRotate.value = (lightboxRotate.value + 90) % 360
}

function resetLightbox() {
  lightboxScale.value = 1
  lightboxRotate.value = 0
}

async function handlePreviewClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return

  // 图片点击放大预览
  const img = target.closest("img") as HTMLImageElement | null
  if (img && img.src) {
    event.preventDefault()
    openLightbox(img.src, img.alt || "图片预览")
    return
  }

  // 链接外部打开
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

// ----------------------------------------------------
// 最近文件与路径工具
// ----------------------------------------------------
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

  const MM = String(date.getMonth() + 1).padStart(2, "0")
  const DD = String(date.getDate()).padStart(2, "0")
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")

  if (isToday) {
    return `今天 ${hh}:${mm}`
  }
  return `${date.getFullYear()}/${MM}/${DD} ${hh}:${mm}`
}

function rememberPath(path: string) {
  recentPaths.value = sanitizeRecentPaths([path, ...recentPaths.value.filter((item) => item !== path)])
  persistRecentPaths()
}

function removeRecentPath(pathToRemove: string) {
  recentPaths.value = recentPaths.value.filter((p) => p !== pathToRemove)
  persistRecentPaths()
}

function parsePath(fullPath: string) {
  if (fullPath === "示例内容") {
    return { fileName: "欢迎使用 mzRead.md", parentDir: "内置示例指南" }
  }
  const sep = fullPath.includes("\\") ? "\\" : "/"
  const parts = fullPath.split(sep)
  const fileName = parts[parts.length - 1]
  const parentDir = parts.slice(0, parts.length - 1).join(sep)

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

// ----------------------------------------------------
// 文件保存与编辑
// ----------------------------------------------------
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

function syncPreviewScroll(event: Event) {
  if (editLayoutMode.value !== "split") return
  if (!previewContainerRef.value) return

  const textarea = event.target as HTMLTextAreaElement
  const cursorIndex = textarea.selectionStart
  if (cursorIndex === undefined || cursorIndex === null) return

  const textBeforeCursor = textarea.value.substring(0, cursorIndex)
  const cursorLine = textBeforeCursor.split(/\r?\n/).length - 1

  const elements = Array.from(previewContainerRef.value.querySelectorAll("[data-line]")) as HTMLElement[]
  if (!elements.length) return

  let targetElement = elements[0]
  for (const el of elements) {
    const lineStr = el.getAttribute("data-line")
    if (lineStr) {
      const line = parseInt(lineStr, 10)
      if (line <= cursorLine) {
        targetElement = el
      } else {
        break
      }
    }
  }

  if (targetElement) {
    targetElement.scrollIntoView({ behavior: "smooth", block: "center" })
    targetElement.classList.remove("highlight-flash")
    void targetElement.offsetWidth
    targetElement.classList.add("highlight-flash")
    setTimeout(() => {
      targetElement.classList.remove("highlight-flash")
    }, 2000)
  }
}

// ----------------------------------------------------
// 文件加载与选择
// ----------------------------------------------------
async function loadMarkdownFile(path: string) {
  closeSearch()
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

    activeHeadingId.value = "heading-0"
    saveStatus.value = "saved"
    saveError.value = ""
    isEditing.value = false

    restoreScrollPosition(document.path)
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
  closeSearch()
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
  restoreScrollPosition("示例内容")
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

async function createNewMarkdownFile() {
  try {
    const selected = await save({
      title: "新建 Markdown 文档",
      filters: [
        {
          name: "Markdown",
          extensions: ["md", "markdown"],
        },
      ],
      defaultPath: "未命名.md",
    })

    if (!selected) return

    const initialContent = `# 新建文档\n\n在此开始编写内容...`
    const document = await invoke<MarkdownDocument>("write_markdown_file", {
      path: selected,
      content: initialContent,
    })

    currentDocument.value = document
    rawMarkdown.value = document.content
    rememberPath(document.path)

    activeHeadingId.value = "heading-0"
    saveStatus.value = "saved"
    saveError.value = ""
    isEditing.value = true
    editLayoutMode.value = "split"
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

watch(renderedMarkdown, () => {
  addCodeEnhancements()
  nextTick(() => {
    handleScroll()
  })
})

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

// ----------------------------------------------------
// 全局快捷键分发
// ----------------------------------------------------
function handleKeyDown(event: KeyboardEvent) {
  const isCmdOrCtrl = event.metaKey || event.ctrlKey

  // Esc 键优先关闭 Lightbox，再关闭搜索栏
  if (event.key === "Escape") {
    if (lightboxImage.value) {
      event.preventDefault()
      closeLightbox()
      return
    }
    if (showSearch.value) {
      event.preventDefault()
      closeSearch()
      return
    }
  }

  // Cmd/Ctrl + Q 退出软件
  if (isCmdOrCtrl && event.key.toLowerCase() === "q") {
    event.preventDefault()
    void handleExitApp()
    return
  }

  // Cmd/Ctrl + F 打开页内搜索
  if (isCmdOrCtrl && event.key.toLowerCase() === "f") {
    event.preventDefault()
    toggleSearch()
    return
  }

  // Cmd/Ctrl + \ 折叠/展开侧边栏
  if (isCmdOrCtrl && event.key === "\\") {
    event.preventDefault()
    isSidebarOpen.value = !isSidebarOpen.value
    return
  }

  // Cmd/Ctrl + O 打开文件选择器
  if (isCmdOrCtrl && event.key.toLowerCase() === "o") {
    event.preventDefault()
    void pickMarkdownFile()
    return
  }

  // Cmd/Ctrl + = 或 Cmd/Ctrl + + 放大字号
  if (isCmdOrCtrl && (event.key === "=" || event.key === "+")) {
    event.preventDefault()
    zoomInFont()
    return
  }

  // Cmd/Ctrl + - 缩小字号
  if (isCmdOrCtrl && event.key === "-") {
    event.preventDefault()
    zoomOutFont()
    return
  }

  // Cmd/Ctrl + 0 重置字号
  if (isCmdOrCtrl && event.key === "0") {
    event.preventDefault()
    resetFontSize()
    return
  }

  // Cmd/Ctrl + S 保存文件
  if (isCmdOrCtrl && event.key.toLowerCase() === "s") {
    event.preventDefault()
    void forceSaveIfDirty()
    return
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

  // 启动文件外部监听轮询
  fileWatchIntervalId = window.setInterval(checkFileExternalUpdate, 1500)

  window.addEventListener("click", closeMenus)
  window.addEventListener("keydown", handleKeyDown)
})

onUnmounted(() => {
  if (fileWatchIntervalId) clearInterval(fileWatchIntervalId)
  if (noticeTimeoutId) clearTimeout(noticeTimeoutId)
  if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer)
  window.removeEventListener("click", closeMenus)
  window.removeEventListener("keydown", handleKeyDown)
})
</script>

<template>
  <div class="flex flex-col h-screen overflow-hidden bg-background text-foreground relative">
    <!-- 顶部 2px 极简阅读进度条 -->
    <div class="reading-progress-track">
      <div class="reading-progress-bar" :style="{ width: `${readingProgress}%` }"></div>
    </div>

    <!-- 顶部极简状态栏 (元信息与排版统计) -->
    <div class="h-7 shrink-0 bg-muted/40 border-b flex items-center justify-between px-3 text-[10px] text-muted-foreground select-none z-30">
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="size-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
        <span class="font-medium">mzRead</span>
        <span v-if="currentDocument" class="text-muted-foreground/30 font-light">|</span>
        <span v-if="currentDocument" class="truncate max-w-[240px] font-mono text-[9px] text-muted-foreground/90">
          {{ currentDocument.file_name }}
        </span>
      </div>

      <!-- 右侧多维统计信息：字数、阅读时长、修改时间 -->
      <div class="flex items-center gap-3 text-[9px]">
        <template v-if="currentDocument">
          <span class="bg-muted px-1.5 py-0.5 rounded-md text-foreground/80 font-mono">
            {{ documentStats.words.toLocaleString() }} 词 / {{ documentStats.characters.toLocaleString() }} 字
          </span>
          <span class="bg-muted px-1.5 py-0.5 rounded-md text-foreground/80 flex items-center gap-1 font-mono">
            <Clock class="size-2.5 text-muted-foreground" />
            约 {{ documentStats.readingTimeMinutes }} 分钟
          </span>
          <span class="text-muted-foreground/80 hidden sm:inline">
            最后更新: {{ modifiedLabel }}
          </span>
        </template>
        <span v-else class="text-muted-foreground/60">准备就绪</span>
      </div>
    </div>

    <main class="flex flex-1 min-h-0 relative">
      <!-- 侧边栏 (滑动过渡) -->
      <aside
        :class="[
          'flex shrink-0 flex-col bg-muted/20 border-r transition-all duration-300 ease-in-out z-30 h-full max-h-full overflow-hidden',
          isSidebarOpen ? 'w-[280px]' : 'w-0 border-r-0',
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

            <!-- 右击退出菜单 -->
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
            <div class="grid grid-cols-2 gap-1.5">
              <Button class="justify-center cursor-pointer text-xs h-9 shadow-sm" :disabled="isLoading" @click="pickMarkdownFile">
                <FolderOpen class="size-3.5" />
                打开文件
              </Button>
              <Button class="justify-center cursor-pointer text-xs h-9 shadow-sm" :disabled="isLoading" @click="createNewMarkdownFile">
                <FilePlus class="size-3.5" />
                新建文件
              </Button>
            </div>
            <div class="grid grid-cols-2 gap-1.5">
              <Button
                variant="outline"
                class="justify-center cursor-pointer text-xs h-9"
                :disabled="!currentDocument || isLoading"
                @click="refreshCurrentFile"
                title="重新载入文件"
              >
                <RefreshCcw class="size-3.5" />
                刷新
              </Button>
              <Button variant="outline" class="justify-center cursor-pointer text-xs h-9" @click="cycleTheme" title="切换浅色 / 深色 / 护眼暖色主题">
                <Sun v-if="currentTheme === 'light'" class="size-3.5" />
                <Moon v-else-if="currentTheme === 'dark'" class="size-3.5" />
                <Coffee v-else class="size-3.5 text-amber-700" />
                <span>{{ currentTheme === 'light' ? '浅色' : currentTheme === 'dark' ? '深色' : '护眼' }}</span>
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
                    ? (isEditing
                        ? 'bg-primary/10 border-primary/30 shadow-sm ring-1 ring-primary/20'
                        : 'bg-muted/60 border-border/60')
                    : 'border-transparent hover:bg-accent hover:text-accent-foreground',
                ]"
                @click="loadMarkdownFile(path)"
              >
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
          </div>
        </div>
      </aside>

      <!-- 右侧主阅读/编辑视口 -->
      <section class="flex flex-1 min-w-0 flex-col h-full relative">
        <!-- 顶部毛玻璃导航 Header -->
        <header class="flex h-14 shrink-0 items-center justify-between border-b px-4 bg-background/80 backdrop-blur-md sticky top-0 z-20">
          <div class="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              class="size-8 cursor-pointer rounded-lg text-muted-foreground hover:text-foreground"
              @click="isSidebarOpen = !isSidebarOpen"
              title="切换侧边栏 (⌘\)"
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
            <!-- 保存状态提示 -->
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
                title="双栏分屏"
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

            <!-- 字号调节与重置 (A- / 16 / A+) -->
            <div v-if="currentDocument" class="hidden sm:flex items-center bg-muted/50 rounded-lg p-0.5 mr-1 select-none">
              <span class="px-1 text-muted-foreground/60 flex items-center" title="正文字号调节"><Type class="size-3" /></span>
              <button
                class="size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground cursor-pointer text-xs"
                @click="zoomOutFont"
                title="缩小字号 (⌘-)"
              >
                <span class="text-[11px] font-medium leading-none">A-</span>
              </button>
              <button
                class="px-1.5 text-[10px] font-mono text-muted-foreground hover:text-foreground cursor-pointer"
                @click="resetFontSize"
                title="重置字号 (⌘0)"
              >
                {{ fontSize }}
              </button>
              <button
                class="size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground cursor-pointer text-xs"
                @click="zoomInFont"
                title="放大字号 (⌘+)"
              >
                <span class="text-[11px] font-medium leading-none">A+</span>
              </button>
            </div>

            <!-- 宽屏/标准排版切换 -->
            <Button
              v-if="currentDocument"
              variant="ghost"
              size="icon"
              :class="['size-8 cursor-pointer rounded-lg mr-1 transition-colors', isWideMode ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground']"
              @click="toggleWideMode"
              :title="isWideMode ? '切换为黄金标准阅读宽度' : '切换为宽屏模式 (适配大表格/长代码)'"
            >
              <Maximize2 v-if="!isWideMode" class="size-3.5" />
              <Minimize2 v-else class="size-3.5" />
            </Button>

            <!-- 搜索开关 -->
            <Button
              v-if="currentDocument"
              variant="ghost"
              size="icon"
              :class="['size-8 cursor-pointer rounded-lg mr-1 transition-colors', showSearch ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground']"
              @click="toggleSearch"
              title="在文档中搜索 (⌘F)"
            >
              <Search class="size-4" />
            </Button>

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

            <!-- 大纲目录开关 -->
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

        <!-- 悬浮式页内查找栏 (Cmd/Ctrl + F) -->
        <div
          v-if="showSearch"
          class="absolute right-4 top-16 z-40 flex items-center gap-2 p-1.5 pl-3 rounded-xl border border-border bg-background/90 backdrop-blur-md shadow-xl shadow-black/10 select-none animate-fade-in"
        >
          <Search class="size-3.5 text-muted-foreground shrink-0" />
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            type="text"
            placeholder="搜索文档内容..."
            class="w-44 bg-transparent text-xs text-foreground focus:outline-none border-none placeholder-muted-foreground font-sans"
            @input="performSearch"
            @keydown.enter.prevent="(event) => { if (event.shiftKey) { handleSearchPrev() } else { handleSearchNext() } }"
          />

          <!-- 区分大小写 Aa 开关 -->
          <button
            :class="[
              'size-6 rounded flex items-center justify-center text-[10px] font-mono font-bold transition cursor-pointer',
              isCaseSensitive ? 'bg-primary text-primary-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
            ]"
            title="区分大小写 (Aa)"
            @click="toggleCaseSensitive"
          >
            <CaseSensitive class="size-3.5" />
          </button>

          <!-- 匹配计数与弱提示 -->
          <div class="flex items-center gap-1 shrink-0">
            <span
              :class="[
                'text-[10px] font-mono px-1.5 py-0.5 rounded min-w-[36px] text-center transition-colors',
                searchQuery && Math.max(searchMatches.length, editorMatches.length) === 0
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold'
                  : 'text-muted-foreground',
              ]"
            >
              <template v-if="!searchQuery">0/0</template>
              <template v-else-if="Math.max(searchMatches.length, editorMatches.length) === 0">0/0</template>
              <template v-else>{{ currentMatchIndex + 1 }}/{{ Math.max(searchMatches.length, editorMatches.length) }}</template>
            </span>

            <Separator orientation="vertical" class="h-3 mx-0.5" />

            <Button
              variant="ghost"
              size="icon"
              class="size-6 rounded-md hover:bg-muted cursor-pointer"
              title="上一个 (Shift+Enter)"
              @click="handleSearchPrev"
            >
              <ChevronUp class="size-3.5 text-muted-foreground hover:text-foreground" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              class="size-6 rounded-md hover:bg-muted cursor-pointer"
              title="下一个 (Enter)"
              @click="handleSearchNext"
            >
              <ChevronDown class="size-3.5 text-muted-foreground hover:text-foreground" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              class="size-6 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
              title="关闭 (Esc)"
              @click="closeSearch"
            >
              <X class="size-3.5" />
            </Button>
          </div>
        </div>

        <!-- 外部改动热重载轻量提示横幅 -->
        <div
          v-if="liveReloadNotice"
          class="absolute top-16 left-1/2 -translate-x-1/2 z-40 px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 backdrop-blur-md text-emerald-600 dark:text-emerald-400 text-xs shadow-md flex items-center gap-2 animate-fade-in select-none"
        >
          <span class="size-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
          <span>{{ liveReloadNotice }}</span>
        </div>

        <!-- 异常提示条 -->
        <div v-if="errorMessage" class="border-b border-destructive/20 bg-destructive/5 px-4 py-2.5 text-xs text-destructive flex items-center justify-between shrink-0">
          <span>{{ errorMessage }}</span>
          <button class="text-muted-foreground hover:text-foreground" @click="errorMessage = ''">
            <X class="size-3.5" />
          </button>
        </div>

        <!-- 加载中蒙版 -->
        <div v-if="isLoading" class="absolute inset-0 z-40 bg-background/60 backdrop-blur-xs flex items-center justify-center">
          <div class="flex flex-col items-center gap-3">
            <RefreshCcw class="size-6 text-primary animate-spin" />
            <span class="text-xs text-muted-foreground">正在加载文档内容...</span>
          </div>
        </div>

        <!-- 核心内容区域 (欢迎首屏 OR 正文阅读大纲双栏) -->
        <div class="flex flex-1 min-h-0 overflow-hidden relative">
          <!-- A. 欢迎首屏 -->
          <div v-if="!currentDocument" class="flex-1 flex flex-col items-center justify-center p-6 bg-radial from-background via-background to-muted/10 overflow-y-auto">
            <div class="max-w-[480px] w-full text-center space-y-8 animate-fade-in">
              <div class="space-y-3">
                <div class="mx-auto flex size-16 items-center justify-center overflow-hidden rounded-2xl shadow-lg shadow-primary/10">
                  <img src="/logo.png" alt="mzRead logo" class="size-full object-cover" />
                </div>
                <h1 class="text-2xl font-bold tracking-tight bg-clip-text text-foreground">欢迎使用 mzRead</h1>
                <p class="text-xs text-muted-foreground max-w-sm mx-auto">
                  专注长文档与本地 Markdown 阅读。支持全文页内检索、TOC 联动大纲、多档护眼主题与阅读记忆。
                </p>
              </div>

              <!-- 操作卡片 -->
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
                      <div class="text-xs font-semibold">阅读内置使用指南</div>
                      <div class="text-[10px] text-muted-foreground mt-0.5">查看 mzRead 内置的高清排版与渲染示例</div>
                    </div>
                  </div>
                  <ChevronRight class="size-4 text-muted-foreground group-hover:translate-x-0.5 transition" />
                </button>
              </div>

              <!-- 快捷亮点提示 -->
              <div class="grid grid-cols-2 gap-4 text-left">
                <div class="space-y-1">
                  <h3 class="text-xs font-semibold text-foreground">🔍 快捷页内搜索</h3>
                  <p class="text-[10px] text-muted-foreground leading-relaxed">
                    随时按 ⌘F 唤起，高亮全部匹配并自动居中滚动跳转。
                  </p>
                </div>
                <div class="space-y-1">
                  <h3 class="text-xs font-semibold text-foreground">☕ 护眼与排版自如</h3>
                  <p class="text-[10px] text-muted-foreground leading-relaxed">
                    浅色、深色、羊皮纸暖色切换；支持宽屏模式与字号无级缩放。
                  </p>
                </div>
              </div>
            </div>
          </div>

          <!-- B. 阅读区 / 编辑区 / TOC 布局 -->
          <template v-else>
            <!-- 1. 编辑器模式 -->
            <div
              v-if="isEditing && (editLayoutMode === 'split' || editLayoutMode === 'edit')"
              :class="['flex flex-col h-full', editLayoutMode === 'split' ? 'w-1/2 border-r border-border/50 bg-background' : 'w-full']"
            >
              <textarea
                class="flex-1 w-full p-6 md:p-10 resize-none font-mono text-sm leading-relaxed bg-transparent text-foreground focus:outline-none scroll-container"
                v-model="rawMarkdown"
                @input="onEditorInput"
                @keydown.tab.prevent="handleTextareaTab"
                @click="syncPreviewScroll"
                @keyup="syncPreviewScroll"
                placeholder="开始编写 Markdown..."
                spellcheck="false"
              ></textarea>
            </div>

            <!-- 2. 阅读主视图 -->
            <div
              v-if="!isEditing || editLayoutMode === 'split' || editLayoutMode === 'preview'"
              ref="previewContainerRef"
              :class="['overflow-y-auto scroll-container select-text relative', (!isEditing || editLayoutMode === 'preview') ? 'flex-1' : 'w-1/2 bg-muted/5']"
              @scroll="handleScroll"
            >
              <div class="max-w-none px-6 md:px-12 py-10 w-full">
                <article
                  ref="articleRef"
                  :class="[
                    'prose prose-neutral max-w-none dark:prose-invert prose-headings:scroll-mt-20 prose-pre:rounded-xl prose-pre:border prose-pre:bg-muted/60 prose-pre:text-foreground prose-img:rounded-xl',
                    isWideMode ? 'reading-mode-wide' : '',
                  ]"
                  :style="{ fontSize: `${fontSize}px` }"
                  @click="handlePreviewClick"
                  v-html="renderedMarkdown"
                />
              </div>

              <!-- 回到顶部浮动按钮 -->
              <button
                v-if="showBackToTop"
                class="back-to-top-btn fixed bottom-6 right-8 z-30 size-9 rounded-full bg-primary/90 text-primary-foreground shadow-lg flex items-center justify-center hover:bg-primary cursor-pointer transition-all duration-200"
                @click="scrollToTop"
                title="回到顶部"
              >
                <ArrowUp class="size-4" />
              </button>
            </div>

            <!-- 3. 右侧大纲目录 (TOC) 带搜索过滤与 ScrollSpy -->
            <aside
              v-if="!isEditing || editLayoutMode === 'preview'"
              :class="[
                'shrink-0 border-l bg-muted/10 flex flex-col transition-all duration-300 ease-in-out h-full max-h-full overflow-hidden',
                isTocOpen ? 'w-[230px]' : 'w-0 border-l-0',
              ]"
            >
              <!-- 目录头部与快速过滤输入框 -->
              <div class="p-2.5 border-b space-y-2 shrink-0">
                <div class="flex items-center justify-between">
                  <div class="text-xs font-semibold text-muted-foreground">大纲目录</div>
                  <Badge variant="outline" class="text-[10px] px-1 rounded-full py-0">
                    {{ filteredToc.length }}
                  </Badge>
                </div>
                <!-- 目录过滤框 -->
                <div class="relative">
                  <input
                    v-model="tocSearchQuery"
                    type="text"
                    placeholder="筛选章节..."
                    class="w-full text-[11px] px-2 py-1 pr-6 rounded-md bg-background/50 border border-border/50 focus:outline-none focus:border-primary/50 text-foreground placeholder:text-muted-foreground"
                  />
                  <button
                    v-if="tocSearchQuery"
                    class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    @click="tocSearchQuery = ''"
                  >
                    <X class="size-3" />
                  </button>
                </div>
              </div>

              <div class="flex-1 min-h-0 overflow-y-auto">
                <div v-if="filteredToc.length" class="p-2.5 space-y-1">
                  <button
                    v-for="item in filteredToc"
                    :key="item.id"
                    :data-toc-id="item.id"
                    :class="[
                      'w-full text-left rounded-md px-2 py-1.5 transition-all duration-200 truncate cursor-pointer hover:bg-accent/50',
                      item.level === 1 ? 'font-medium pl-2 text-foreground text-xs' : '',
                      item.level === 2 ? 'pl-4 text-muted-foreground/90 text-xs' : '',
                      item.level === 3 ? 'pl-6 text-muted-foreground/80 text-[11px]' : '',
                      item.level === 4 ? 'pl-8 text-muted-foreground/70 text-[10.5px]' : '',
                      activeHeadingId === item.id ? 'toc-link-active bg-primary/5 border-l-2 border-primary rounded-l-none' : '',
                    ]"
                    @click="scrollToHeading(item.id)"
                    :title="item.text"
                  >
                    {{ item.text }}
                  </button>
                </div>
                <p v-else class="p-4 text-xs text-muted-foreground text-center">
                  {{ tocSearchQuery ? '无匹配章节' : '未检测到文档标题' }}
                </p>
              </div>
            </aside>
          </template>
        </div>
      </section>
    </main>

    <!-- 全屏图片查看器 (Lightbox) -->
    <div
      v-if="lightboxImage"
      class="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex flex-col animate-fade-in select-none"
      @click="closeLightbox"
    >
      <!-- Lightbox 控制栏 -->
      <div class="h-12 flex items-center justify-between px-4 text-white/90 shrink-0 border-b border-white/10" @click.stop>
        <div class="text-xs truncate max-w-md font-mono text-white/70">
          {{ lightboxImage.alt || '图片预览' }} ({{ Math.round(lightboxScale * 100) }}%)
        </div>

        <div class="flex items-center gap-1.5">
          <button
            class="p-1.5 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition cursor-pointer"
            @click="zoomInLightbox"
            title="放大 (+)"
          >
            <ZoomIn class="size-4" />
          </button>
          <button
            class="p-1.5 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition cursor-pointer"
            @click="zoomOutLightbox"
            title="缩小 (-)"
          >
            <ZoomOut class="size-4" />
          </button>
          <button
            class="p-1.5 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition cursor-pointer"
            @click="rotateLightbox"
            title="顺时针旋转 90°"
          >
            <RotateCcw class="size-4" />
          </button>
          <button
            class="p-1.5 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition cursor-pointer"
            @click="resetLightbox"
            title="重置比例"
          >
            <span class="text-xs font-mono">1:1</span>
          </button>
          <Separator orientation="vertical" class="h-4 bg-white/20 mx-1" />
          <button
            class="p-1.5 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition cursor-pointer"
            @click="closeLightbox"
            title="关闭 (Esc)"
          >
            <X class="size-4" />
          </button>
        </div>
      </div>

      <!-- 图片展示主体 -->
      <div class="flex-1 flex items-center justify-center p-6 overflow-hidden">
        <img
          :src="lightboxImage.src"
          :alt="lightboxImage.alt"
          class="max-w-full max-h-full object-contain transition-transform duration-200 ease-out shadow-2xl rounded-lg"
          :style="{
            transform: `scale(${lightboxScale}) rotate(${lightboxRotate}deg)`,
          }"
          @click.stop
        />
      </div>
    </div>
  </div>
</template>

<style>
/* 补充排版细节 */
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
.prose ul,
.prose ol {
  padding-left: 1.25em;
}

.size-4\.5 {
  width: 1.125rem;
  height: 1.125rem;
}
.size-3\.5 {
  width: 0.875rem;
  height: 0.875rem;
}

/* 预览光标跳转高亮动画 */
@keyframes highlight-fade {
  0% {
    background-color: hsl(var(--primary) / 0.2);
    box-shadow: 0 0 0 4px hsl(var(--primary) / 0.1);
  }
  100% {
    background-color: transparent;
    box-shadow: 0 0 0 0 transparent;
  }
}
.highlight-flash {
  animation: highlight-fade 2s ease-out;
  border-radius: 4px;
  transition: all 0.2s;
}

/* 搜索高亮通用样式：普通匹配柔和底色，当前激活匹配橙色醒目突出 */
.search-highlight {
  background-color: rgba(254, 240, 138, 0.85) !important;
  color: #1c1917 !important;
  border-radius: 0.125rem;
  padding: 0 0.125rem;
  transition: all 0.15s ease;
}
.dark .search-highlight {
  background-color: rgba(161, 98, 7, 0.55) !important;
  color: #fef08a !important;
}
.sepia .search-highlight {
  background-color: rgba(253, 224, 71, 0.6) !important;
  color: #422006 !important;
}

.search-highlight-current {
  background-color: #f97316 !important;
  color: #ffffff !important;
  font-weight: 600;
  box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.55);
}
.dark .search-highlight-current {
  background-color: #ea580c !important;
  color: #ffffff !important;
  box-shadow: 0 0 0 2px rgba(234, 88, 12, 0.55);
}
.sepia .search-highlight-current {
  background-color: #c2410c !important;
  color: #ffffff !important;
  box-shadow: 0 0 0 2px rgba(194, 65, 12, 0.55);
}
</style>
