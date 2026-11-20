<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow"
import { open, save } from "@tauri-apps/plugin-dialog"
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener"
import mermaid from "mermaid"
import {
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  Check,
  Loader2,
  AlertCircle,
  FileUp,
  ArrowUp,
  Columns,
  Edit,
  Eye,
  Type,
  Maximize2,
  Minimize2,
  List,
  PanelTop,
  PanelTopDashed,
} from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { renderMarkdown, resolveRelativePath, getDirectoryFromPath } from "@/lib/markdown"

// 拆分子组件
import AppHeader from "@/components/AppHeader.vue"
import AppSidebar from "@/components/AppSidebar.vue"
import TocPanel from "@/components/TocPanel.vue"
import SearchBar from "@/components/SearchBar.vue"
import ImageLightbox from "@/components/ImageLightbox.vue"

// Composables
import { useScrollSpy } from "@/composables/useScrollSpy"
import { useEditorDebounce } from "@/composables/useEditorDebounce"
import { useFileWatch } from "@/composables/useFileWatch"
import { useSearch } from "@/composables/useSearch"
import {
  useEditorPreviewSync,
  computeLineOffsets,
  getLineAtOffset,
} from "@/composables/useEditorPreviewSync"

interface MarkdownDocument {
  path: string
  file_name: string
  content: string
  size_bytes: number
  modified_ms: number | null
}

const RECENT_KEY = "mzread-recent-paths"
const THEME_KEY = "mzread-theme"
const SCROLL_POS_KEY = "mzread-scroll-positions"
const WIDE_MODE_KEY = "mzread-wide-mode"
const FONT_SIZE_KEY = "mzread-font-size"
const READ_TIMEOUT_MS = 15_000
const systemDarkQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : { matches: false }

const sampleMarkdown = `# 欢迎使用 mzRead

这是一个轻量、专注、现代化的本地 Markdown 与长文档阅读器。

## 核心功能与亮点

- [x] **本地极速打开**：打开本地 \`.md\` / \`.markdown\` 文档，极速解析
- [x] **本地相对图片与文档跳转**：支持本地相对路径图片展示与 Markdown 文档内链直接打开
- [x] **大纲目录 (TOC) 精准联动**：基于 AST 解析提取标题树，告别正则错位
- [x] **代码块多主题高亮**：轻量级语法高亮，完美契合 Light / Dark / Sepia 三套主题
- [x] **扩展语法支持**：支持任务列表、数学公式 (KaTeX)、Mermaid 图表与脚注
- [x] **拖拽直接打开 (Drag & Drop)**：从 Finder 或资源管理器直接拖入文档快速阅读
- [ ] **页内快速搜索 (⌘F)**：悬浮毛玻璃搜索栏，支持实时计数、区分大小写 (Aa)
- [ ] **阅读位置记忆**：自动记忆并恢复每篇文档上次的阅读滚动位置

### 代码语法高亮示例

\`\`\`rust
fn main() {
    println!("Hello, mzRead with syntax highlighting!");
}
\`\`\`

\`\`\`typescript
interface ReaderConfig {
  theme: "light" | "dark" | "sepia";
  fontSize: number;
  wideMode: boolean;
  highlightEnabled: boolean;
}
\`\`\`

### 数学公式 (KaTeX) 示例

行内质能方程：$E = mc^2$，以及高斯积分块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

### Mermaid 流程图示例

\`\`\`mermaid
graph LR
    A[拖入本地 .md 文件] --> B(Tauri 捕获路径)
    B --> C{解析 Markdown}
    C --> D[生成高亮 HTML & 精准 TOC]
    D --> E[沉浸式阅读]
\`\`\`

### 脚注示例

mzRead 为技术文档和论文阅读提供专门优化[^1]。

[^1]: 这里是脚注内容：支持双向跳转与轻量排版。

> 提示：点击左侧侧栏的「打开 Markdown」或直接拖入文件即可开始体验。`

// ----------------------------------------------------
// 核心状态管理
// ----------------------------------------------------
const currentDocument = ref<MarkdownDocument | null>(null)
const errorMessage = ref("")
const isLoading = ref(false)
const recentPaths = ref<string[]>([])
const recentFilesMetadata = ref<Record<string, number>>({})

// 界面布局与侧栏
const isSidebarOpen = ref(true)
const isTocOpen = ref(true)
const isEditing = ref(false)
const showTrayIcon = ref(false)
const isTogglingTray = ref(false)
const editLayoutMode = ref<"split" | "edit" | "preview">("split")
const saveStatus = ref<"saved" | "saving" | "dirty" | "readonly">("saved")
const saveError = ref("")
let saveTimeoutId: number | null = null

// 主题模式：'light' | 'dark' | 'sepia'
type ThemeMode = "light" | "dark" | "sepia"
const initialTheme = (typeof localStorage !== "undefined" && (localStorage.getItem(THEME_KEY) as ThemeMode)) || (systemDarkQuery.matches ? "dark" : "light")
const currentTheme = ref<ThemeMode>(initialTheme)

// 排版模式：宽屏与字号
const isWideMode = ref(typeof localStorage !== "undefined" && localStorage.getItem(WIDE_MODE_KEY) === "true")
const fontSize = ref(Number(typeof localStorage !== "undefined" && localStorage.getItem(FONT_SIZE_KEY)) || 16)

// 容器引用与拖拽
const workspaceRef = ref<HTMLElement | null>(null)
const workspaceWidth = ref(1000)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const editorBackdropRef = ref<HTMLElement | null>(null)
const editorClientWidth = ref(0)
const previewContainerRef = ref<HTMLElement | null>(null)
const articleRef = ref<HTMLElement | null>(null)
const isDraggingFile = ref(false)
let unlistenDragDrop: (() => void) | null = null

const isSplitEdit = computed(() => isEditing.value && editLayoutMode.value === "split")
const isTocOverlay = computed(() => isSplitEdit.value && workspaceWidth.value < 740)
const isTocCompact = computed(() => isSplitEdit.value && !isTocOverlay.value)
const editorPaddingClass = computed(() =>
  isSplitEdit.value ? "px-5 py-6 md:px-7 md:py-8" : "p-6 md:p-10",
)

// Lightbox 图片预览
const lightboxImage = ref<{ src: string; alt: string } | null>(null)

// 外部文件更新通知 (Live Reload)
const liveReloadNotice = ref("")
let noticeTimeoutId: number | null = null

// ----------------------------------------------------
// 1. 编辑器防抖 (分离即时响应与全量重绘)
// ----------------------------------------------------
const { rawMarkdown, debouncedMarkdown, forceFlushSync } = useEditorDebounce("", 200)

// 全量 Markdown 解析只消费经过防抖的 debouncedMarkdown
const currentDocPathComputed = computed(() => currentDocument.value?.path)
const markdownResult = computed(() =>
  renderMarkdown(debouncedMarkdown.value, currentDocPathComputed.value),
)
const renderedMarkdown = computed(() => markdownResult.value.html)
const toc = computed(() => markdownResult.value.toc)

const documentTitle = computed(() => currentDocument.value?.file_name ?? "未打开文档")
const characterCount = computed(() => rawMarkdown.value.length)
const lineCount = computed(() => rawMarkdown.value.split(/\r\n|\r|\n/).length)

const documentStats = computed(() => {
  const text = debouncedMarkdown.value || ""
  if (!text) return { words: 0, characters: 0, readingTimeMinutes: 0 }
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
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
  const date = new Date(modified)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
})

// ----------------------------------------------------
// 2. 滚动事件监听 (rAF 节流 + 缓存标题引用)
// ----------------------------------------------------
const {
  activeHeadingId,
  readingProgress,
  showBackToTop,
  updateCachedHeadings,
  handleScroll,
  onContainerScroll,
  scrollToTop,
  scrollToHeading,
} = useScrollSpy(previewContainerRef, articleRef, currentDocPathComputed, recordScrollPosition)

// ----------------------------------------------------
// 3. 搜索功能 (编辑模式下优先搜索源码并同步预览；输入时不抢焦点)
// ----------------------------------------------------
const {
  showSearch,
  searchQuery,
  isCaseSensitive,
  currentMatchIndex,
  totalMatches: totalSearchMatches,
  editorBackdropHtml,
  isEditorSearchMode,
  performSearch,
  handleSearchNext,
  handleSearchPrev,
  toggleCaseSensitive,
  closeSearch,
  openSearch,
} = useSearch(
  articleRef,
  rawMarkdown,
  isEditing,
  editLayoutMode,
  textareaRef,
  editorBackdropRef,
  previewContainerRef,
)

// ----------------------------------------------------
// 3.5 编辑与预览联动选中 (左侧选区实时同步右侧高亮)
// ----------------------------------------------------
const {
  clearPreviewSelection,
  syncPreviewToSelection,
} = useEditorPreviewSync(
  rawMarkdown,
  textareaRef,
  previewContainerRef,
  articleRef,
  isEditing,
  editLayoutMode,
)

let selectionSyncRafId: number | null = null
function scheduleSelectionSync(options: { scrollIfOutOfView?: boolean; syncCursorScroll?: boolean } = {}) {
  if (selectionSyncRafId !== null) cancelAnimationFrame(selectionSyncRafId)
  selectionSyncRafId = requestAnimationFrame(() => {
    selectionSyncRafId = null
    syncPreviewToSelection(options)
  })
}

watch(searchQuery, () => {
  if (showSearch.value) {
    nextTick(() => {
      performSearch({ scrollToCurrent: true })
    })
  }
})

watch([isEditing, editLayoutMode], () => {
  if (!isSplitEdit.value) {
    clearPreviewSelection()
  }
  if (showSearch.value) {
    nextTick(() => {
      performSearch({ scrollToCurrent: true })
    })
  }
})

watch(rawMarkdown, () => {
  if (showSearch.value && isEditorSearchMode.value) {
    nextTick(() => {
      performSearch({ scrollToCurrent: false })
    })
  }
  nextTick(() => {
    updateEditorClientWidth()
  })
})

watch(renderedMarkdown, () => {
  nextTick(() => {
    if (showSearch.value) {
      performSearch({ scrollToCurrent: !isEditorSearchMode.value })
    }
    if (
      isSplitEdit.value &&
      textareaRef.value &&
      textareaRef.value.selectionStart !== textareaRef.value.selectionEnd
    ) {
      syncPreviewToSelection({ scrollIfOutOfView: false })
    }
  })
})

// ----------------------------------------------------
// 4. 外部文件更新检测 (零开销 notify 驱动 + document.hidden 保护)
// ----------------------------------------------------
const { setupWatch } = useFileWatch(currentDocument, async () => {
  // 外部文件更新处理
  if (!currentDocument.value || currentDocument.value.path === "示例内容") return
  try {
    const latestDoc = await invoke<MarkdownDocument>("read_markdown_file", {
      path: currentDocument.value.path,
    })
    if (latestDoc.content !== rawMarkdown.value) {
      if (isEditing.value && saveStatus.value === "dirty") {
        liveReloadNotice.value = "检测到外部程序修改了此文件，当前编辑有未保存更改，未覆盖"
        showNotice()
        return
      }

      const currentScroll = previewContainerRef.value?.scrollTop || 0
      currentDocument.value = latestDoc
      forceFlushSync(latestDoc.content)
      saveStatus.value = "saved"
      liveReloadNotice.value = "检测到文件被外部修改，已自动热更新"
      showNotice()

      nextTick(() => {
        if (previewContainerRef.value && currentScroll > 0) {
          previewContainerRef.value.scrollTop = currentScroll
        }
      })
    } else {
      currentDocument.value.modified_ms = latestDoc.modified_ms
    }
  } catch {}
})

function showNotice() {
  if (noticeTimeoutId) clearTimeout(noticeTimeoutId)
  noticeTimeoutId = window.setTimeout(() => {
    liveReloadNotice.value = ""
  }, 4000)
}

// ----------------------------------------------------
// 5. 主题控制
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
    renderMermaidDiagrams()
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
// 6. Mermaid 流程图与代码高亮增强
// ----------------------------------------------------
async function renderMermaidDiagrams() {
  await nextTick()
  if (!articleRef.value) return
  const mermaidContainers = articleRef.value.querySelectorAll<HTMLElement>(".mermaid")
  if (mermaidContainers.length === 0) return

  try {
    mermaid.initialize({
      startOnLoad: false,
      theme:
        currentTheme.value === "dark"
          ? "dark"
          : currentTheme.value === "sepia"
          ? "neutral"
          : "default",
      securityLevel: "loose",
      fontFamily: "inherit",
    })
    await mermaid.run({
      nodes: mermaidContainers as any,
    })
  } catch (err) {
    console.warn("Mermaid 流程图渲染异常:", err)
  }
}

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

      const codeElement = pre.querySelector("code")
      const classAttr = codeElement?.getAttribute("class") || ""
      const langMatch = classAttr.match(/language-([a-zA-Z0-9_+-]+)/)
      if (langMatch && langMatch[1]) {
        const langBadge = document.createElement("span")
        langBadge.className =
          "code-lang-badge absolute right-11 top-2.5 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-muted/80 text-muted-foreground uppercase tracking-wider select-none opacity-60 group-hover:opacity-100 transition pointer-events-none"
        langBadge.textContent = langMatch[1].toUpperCase()
        wrapper.appendChild(langBadge)
      }

      const button = document.createElement("button")
      button.className =
        "copy-code-btn absolute right-3 top-2.5 size-7 flex items-center justify-center p-0 rounded-lg border border-border bg-background/90 text-muted-foreground transition opacity-0 hover:text-foreground hover:bg-background shadow-xs cursor-pointer z-10"
      button.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="copy-svg"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      `
      button.addEventListener("click", async () => {
        if (codeElement) {
          try {
            await navigator.clipboard.writeText(codeElement.innerText)
            button.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="check-svg text-emerald-500"><polyline points="20 6 9 17 4 12"/></svg>
            `
            setTimeout(() => {
              button.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="copy-svg"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
              `
            }, 2000)
          } catch {}
        }
      })
      wrapper.appendChild(button)
    })
  })
}

watch(renderedMarkdown, () => {
  addCodeEnhancements()
  renderMermaidDiagrams()
  updateCachedHeadings()
  nextTick(() => {
    handleScroll()
  })
})

// ----------------------------------------------------
// 7. 图片 Lightbox
// ----------------------------------------------------
function openLightbox(src: string, alt: string) {
  lightboxImage.value = { src, alt }
}

function closeLightbox() {
  lightboxImage.value = null
}

// ----------------------------------------------------
// 8. 预览区点击拦截 (图片 / 锚点平滑 / 相对内链直接打开)
// ----------------------------------------------------
async function handlePreviewClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return

  const img = target.closest("img") as HTMLImageElement | null
  if (img && img.src) {
    event.preventDefault()
    openLightbox(img.src, img.alt || "图片预览")
    return
  }

  const link = target.closest("a[href]") as HTMLAnchorElement | null
  if (!link) return

  const href = link.getAttribute("href")?.trim()
  if (!href) return

  // A. 页内锚点平滑跳转
  if (href.startsWith("#")) {
    event.preventDefault()
    const targetId = decodeURIComponent(href.slice(1))
    if (!targetId) return
    const targetEl =
      document.getElementById(targetId) ||
      document.querySelector(`[name="${CSS.escape(targetId)}"]`)
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: "smooth", block: "start" })
      activeHeadingId.value = targetId
    }
    return
  }

  // B. 外部网络 URL
  if (
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("tel:") ||
    href.startsWith("//")
  ) {
    event.preventDefault()
    try {
      await openUrl(link.href)
    } catch (error) {
      errorMessage.value = toErrorMessage(error)
    }
    return
  }

  // C. 本地相对路径
  const [rawRelPath, anchor] = href.split("#")
  const currentDocPath = currentDocument.value?.path

  if (currentDocPath && currentDocPath !== "示例内容") {
    event.preventDefault()
    const docDir = getDirectoryFromPath(currentDocPath)
    const targetAbsPath = resolveRelativePath(docDir, rawRelPath)

    const isMarkdown = /\.(md|markdown|mdown|mkd)$/i.test(rawRelPath)
    if (isMarkdown) {
      try {
        await loadMarkdownFile(targetAbsPath)
        if (anchor) {
          nextTick(() => {
            setTimeout(() => {
              const anchorId = decodeURIComponent(anchor)
              const el =
                document.getElementById(anchorId) ||
                document.querySelector(`[name="${CSS.escape(anchorId)}"]`)
              if (el) {
                el.scrollIntoView({ behavior: "smooth", block: "start" })
                activeHeadingId.value = anchorId
              }
            }, 150)
          })
        }
      } catch (error) {
        errorMessage.value = `打开关联文档失败：${toErrorMessage(error)}`
      }
      return
    } else {
      try {
        await openPath(targetAbsPath)
      } catch (error) {
        errorMessage.value = `打开本地文件失败：${toErrorMessage(error)}`
      }
      return
    }
  }
}

// ----------------------------------------------------
// 9. 编辑器与文件保存逻辑
// ----------------------------------------------------
function onEditorInput() {
  if (currentDocument.value?.path === "示例内容") {
    saveStatus.value = "readonly"
    return
  }
  saveStatus.value = "dirty"
  if (saveTimeoutId) clearTimeout(saveTimeoutId)
  saveTimeoutId = window.setTimeout(async () => {
    await saveCurrentFile()
  }, 1000)
}

function handleTextareaTab(e: KeyboardEvent) {
  const target = e.target as HTMLTextAreaElement
  const start = target.selectionStart
  const end = target.selectionEnd
  rawMarkdown.value = rawMarkdown.value.substring(0, start) + "  " + rawMarkdown.value.substring(end)
  nextTick(() => {
    target.selectionStart = target.selectionEnd = start + 2
  })
}

function updateEditorClientWidth() {
  if (textareaRef.value) {
    editorClientWidth.value = textareaRef.value.clientWidth
  }
}

function updateActiveHeadingByEditorLine(line: number) {
  if (!isEditing.value || editLayoutMode.value !== "edit" || toc.value.length === 0) return
  let active = toc.value[0]
  for (const item of toc.value) {
    if (item.line <= line) {
      active = item
    } else {
      break
    }
  }
  if (active) {
    activeHeadingId.value = active.id
  }
}

function onEditorScroll() {
  const textarea = textareaRef.value
  if (!textarea) return

  if (editorBackdropRef.value) {
    editorBackdropRef.value.scrollTop = textarea.scrollTop
    editorBackdropRef.value.scrollLeft = textarea.scrollLeft
  }

  if (isEditing.value && editLayoutMode.value === "edit") {
    const maxScroll = textarea.scrollHeight - textarea.clientHeight
    const ratio = maxScroll > 0 ? Math.min(1, Math.max(0, textarea.scrollTop / maxScroll)) : 0
    readingProgress.value = ratio * 100
    const approxLine = Math.floor(ratio * Math.max(0, lineCount.value - 1))
    updateActiveHeadingByEditorLine(approxLine)
  }
}

function handleEditorInteraction(syncCursorScroll: boolean) {
  const textarea = textareaRef.value
  if (!textarea) return

  if (isEditing.value && editLayoutMode.value === "edit") {
    const offsets = computeLineOffsets(rawMarkdown.value)
    const cursorLine = getLineAtOffset(offsets, textarea.selectionStart)
    updateActiveHeadingByEditorLine(cursorLine)
    return
  }

  scheduleSelectionSync({
    scrollIfOutOfView: true,
    syncCursorScroll,
  })
}

function measureOffsetTopInTextarea(
  textarea: HTMLTextAreaElement,
  textBefore: string,
  paddingClass: string,
): number {
  const mirror = document.createElement("div")
  mirror.className = `editor-mirror-shared ${paddingClass}`
  mirror.style.position = "fixed"
  mirror.style.visibility = "hidden"
  mirror.style.pointerEvents = "none"
  mirror.style.top = "-9999px"
  mirror.style.left = "-9999px"
  mirror.style.width = `${textarea.clientWidth}px`
  mirror.textContent = textBefore + "\u200b"
  document.body.appendChild(mirror)

  const computedStyle = getComputedStyle(textarea)
  const paddingTop = parseFloat(computedStyle.paddingTop) || 0
  const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0
  const lineHeight = parseFloat(computedStyle.lineHeight) || 22.75
  const contentTop = Math.max(0, mirror.scrollHeight - paddingTop - paddingBottom - lineHeight)
  document.body.removeChild(mirror)
  return contentTop
}

function scrollEditorToLine(line: number) {
  const textarea = textareaRef.value
  if (!textarea) return
  if (line <= 0) {
    textarea.scrollTo({ top: 0, behavior: "smooth" })
    return
  }
  const offsets = computeLineOffsets(rawMarkdown.value)
  const charOffset = offsets[Math.min(line, offsets.length - 1)]
  const top = measureOffsetTopInTextarea(
    textarea,
    rawMarkdown.value.slice(0, charOffset),
    editorPaddingClass.value,
  )
  textarea.scrollTo({ top: Math.max(0, top - 16), behavior: "smooth" })
}

function handleTocSelect(id: string) {
  activeHeadingId.value = id
  if (!isEditing.value || editLayoutMode.value !== "edit") {
    scrollToHeading(id)
  }
  if (isEditing.value && editLayoutMode.value !== "preview") {
    const tocItem = toc.value.find((item) => item.id === id)
    if (tocItem) {
      scrollEditorToLine(tocItem.line)
    }
  }
}

function handleSearchClose() {
  closeSearch({ focusEditor: true })
}

async function saveCurrentFile() {
  if (!currentDocument.value || currentDocument.value.path === "示例内容") return
  if (saveStatus.value !== "dirty") return

  saveStatus.value = "saving"
  saveError.value = ""

  try {
    const updated = await invoke<MarkdownDocument>("write_markdown_file", {
      path: currentDocument.value.path,
      content: rawMarkdown.value,
    })
    currentDocument.value = updated
    saveStatus.value = "saved"
    updateRecentFileMetadata(updated.path, updated.modified_ms || Date.now())
  } catch (error) {
    saveStatus.value = "dirty"
    saveError.value = toErrorMessage(error)
  }
}

async function forceSaveIfDirty() {
  if (saveTimeoutId) {
    clearTimeout(saveTimeoutId)
    saveTimeoutId = null
  }
  if (saveStatus.value === "dirty") {
    await saveCurrentFile()
  }
}

async function toggleEditMode() {
  if (!isEditing.value) {
    isEditing.value = true
  } else {
    await forceSaveIfDirty()
    isEditing.value = false
  }
}

async function toggleTrayIcon() {
  if (isTogglingTray.value) return
  isTogglingTray.value = true
  try {
    showTrayIcon.value = await invoke<boolean>("set_tray_visible", {
      visible: !showTrayIcon.value,
    })
  } catch (error) {
    errorMessage.value = toErrorMessage(error)
  } finally {
    isTogglingTray.value = false
  }
}

// ----------------------------------------------------
// 10. 文件加载与管理
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
    forceFlushSync(document.content)
    rememberPath(document.path)
    await setupWatch(document.path)

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
  forceFlushSync(sampleMarkdown)
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
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }],
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
      defaultPath: "Untitled.md",
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    })
    if (!selected) return

    await invoke("write_markdown_file", {
      path: selected,
      content: "# 未命名文档\n\n开始编写内容...",
    })
    await loadMarkdownFile(selected)
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

// ----------------------------------------------------
// 11. 安全退出与未保存保护
// ----------------------------------------------------
async function handleExitApp() {
  await forceSaveIfDirty()
  await invoke("exit_app")
}

// ----------------------------------------------------
// 12. 最近文档与位置记忆
// ----------------------------------------------------
function recordScrollPosition(path: string, top: number) {
  try {
    const positions = JSON.parse(localStorage.getItem(SCROLL_POS_KEY) || "{}")
    positions[path] = top
    localStorage.setItem(SCROLL_POS_KEY, JSON.stringify(positions))
  } catch {}
}

function restoreScrollPosition(path: string) {
  nextTick(() => {
    try {
      const positions = JSON.parse(localStorage.getItem(SCROLL_POS_KEY) || "{}")
      const savedTop = positions[path] || 0
      if (previewContainerRef.value && savedTop > 0) {
        previewContainerRef.value.scrollTop = savedTop
      }
    } catch {}
  })
}

function rememberPath(path: string) {
  if (!path || path === "示例内容") return
  const current = [path, ...recentPaths.value.filter((item) => item !== path)].slice(0, 30)
  recentPaths.value = current
  localStorage.setItem(RECENT_KEY, JSON.stringify(current))
  void invoke("update_recent_paths", { paths: current })
  fetchRecentFilesMetadata([path])
}

function removeRecentPath(path: string) {
  recentPaths.value = recentPaths.value.filter((item) => item !== path)
  localStorage.setItem(RECENT_KEY, JSON.stringify(recentPaths.value))
  void invoke("update_recent_paths", { paths: recentPaths.value })
}

function updateRecentFileMetadata(path: string, ms: number) {
  recentFilesMetadata.value = {
    ...recentFilesMetadata.value,
    [path]: ms,
  }
}

async function fetchRecentFilesMetadata(paths: string[]) {
  if (!paths.length) return
  try {
    const meta = await invoke<Record<string, number>>("get_files_metadata", { paths })
    recentFilesMetadata.value = { ...recentFilesMetadata.value, ...meta }
  } catch {}
}

function readRecentPaths() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]")
    if (Array.isArray(parsed)) {
      recentPaths.value = parsed
      void fetchRecentFilesMetadata(parsed)
    }
  } catch {}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`读取超时（超过 ${timeoutMs / 1000} 秒）`)), timeoutMs),
    ),
  ])
}

function toErrorMessage(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return "发生未知错误"
}

// ----------------------------------------------------
// 13. 快捷键
// ----------------------------------------------------
function handleKeyDown(event: KeyboardEvent) {
  const isCmdOrCtrl = event.metaKey || event.ctrlKey

  if (isCmdOrCtrl && event.key === "=") {
    event.preventDefault()
    zoomInFont()
    return
  }
  if (isCmdOrCtrl && event.key === "-") {
    event.preventDefault()
    zoomOutFont()
    return
  }
  if (isCmdOrCtrl && event.key === "0") {
    event.preventDefault()
    resetFontSize()
    return
  }
  if (isCmdOrCtrl && event.key.toLowerCase() === "f") {
    event.preventDefault()
    openSearch()
    return
  }
  if (isCmdOrCtrl && event.key.toLowerCase() === "e") {
    event.preventDefault()
    void toggleEditMode()
    return
  }
  if (isCmdOrCtrl && event.key === "\\") {
    event.preventDefault()
    isSidebarOpen.value = !isSidebarOpen.value
    return
  }
  if (isCmdOrCtrl && event.key.toLowerCase() === "s") {
    event.preventDefault()
    void forceSaveIfDirty()
    return
  }
  if (isCmdOrCtrl && event.key.toLowerCase() === "q") {
    event.preventDefault()
    void handleExitApp()
    return
  }
}

let workspaceObserver: ResizeObserver | null = null
let textareaObserver: ResizeObserver | null = null

watch(textareaRef, (el) => {
  if (textareaObserver) {
    textareaObserver.disconnect()
    textareaObserver = null
  }
  if (el && typeof ResizeObserver !== "undefined") {
    updateEditorClientWidth()
    textareaObserver = new ResizeObserver(() => {
      updateEditorClientWidth()
    })
    textareaObserver.observe(el)
  }
})

// ----------------------------------------------------
// 14. 生命周期挂载
// ----------------------------------------------------
onMounted(() => {
  readRecentPaths()

  invoke<boolean>("get_tray_visible")
    .then((visible) => {
      showTrayIcon.value = visible
    })
    .catch(() => {})

  if (workspaceRef.value && typeof ResizeObserver !== "undefined") {
    workspaceWidth.value = workspaceRef.value.clientWidth
    workspaceObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        workspaceWidth.value = entry.contentRect.width
      }
    })
    workspaceObserver.observe(workspaceRef.value)
  }

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

  // 监听 Rust 端发出的安全退出请求（先存盘再退出）
  listen("request-exit", async () => {
    await handleExitApp()
  }).catch(() => {})

  // 原生 Drag & Drop 监听
  try {
    const appWindow = getCurrentWebviewWindow()
    appWindow
      .onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") {
          isDraggingFile.value = true
        } else if (event.payload.type === "leave") {
          isDraggingFile.value = false
        } else if (event.payload.type === "drop") {
          isDraggingFile.value = false
          const paths = event.payload.paths
          if (paths && paths.length > 0) {
            void loadFirstOpenedFile(paths)
          }
        }
      })
      .then((unlisten) => {
        unlistenDragDrop = unlisten
      })
      .catch((err) => {
        console.warn("监听拖拽事件失败:", err)
      })
  } catch (err) {
    console.warn("获取 WebviewWindow 异常:", err)
  }

  window.addEventListener("keydown", handleKeyDown)
})

onUnmounted(() => {
  if (unlistenDragDrop) {
    unlistenDragDrop()
    unlistenDragDrop = null
  }
  if (workspaceObserver) {
    workspaceObserver.disconnect()
    workspaceObserver = null
  }
  if (textareaObserver) {
    textareaObserver.disconnect()
    textareaObserver = null
  }
  if (selectionSyncRafId !== null) cancelAnimationFrame(selectionSyncRafId)
  if (noticeTimeoutId) clearTimeout(noticeTimeoutId)
  if (saveTimeoutId) clearTimeout(saveTimeoutId)
  window.removeEventListener("keydown", handleKeyDown)
})
</script>

<template>
  <div class="flex flex-col h-screen overflow-hidden bg-background text-foreground relative">
    <!-- 全屏拖拽文件高亮提示层 -->
    <div
      v-if="isDraggingFile"
      class="fixed inset-0 z-50 flex items-center justify-center bg-background/85 backdrop-blur-xs pointer-events-none transition-all duration-200"
    >
      <div
        class="border-2 border-dashed border-primary/60 bg-primary/5 rounded-2xl p-10 flex flex-col items-center justify-center gap-3 shadow-2xl max-w-md mx-6 text-center animate-in fade-in zoom-in-95 duration-150"
      >
        <div class="size-14 rounded-full bg-primary/10 flex items-center justify-center text-primary">
          <FileUp class="size-7 animate-bounce" />
        </div>
        <div class="text-base font-semibold text-foreground">松开以在此打开 Markdown 文档</div>
        <div class="text-xs text-muted-foreground font-mono">
          支持拖入 .md, .markdown, .mdown, .mkd 文件
        </div>
      </div>
    </div>

    <!-- 顶部状态栏组件 -->
    <AppHeader
      :current-document="currentDocument"
      :stats="documentStats"
      :modified-label="modifiedLabel"
      :progress="readingProgress"
    />

    <main class="flex flex-1 min-h-0 relative">
      <!-- 拆分组件：左侧边栏 -->
      <AppSidebar
        :is-open="isSidebarOpen"
        :is-loading="isLoading"
        :current-document="currentDocument"
        :file-size-label="fileSizeLabel"
        :line-count="lineCount"
        :character-count="characterCount"
        :current-theme="currentTheme"
        :recent-paths="recentPaths"
        :recent-files-metadata="recentFilesMetadata"
        :is-editing="isEditing"
        @pick-file="pickMarkdownFile"
        @new-file="createNewMarkdownFile"
        @refresh-file="refreshCurrentFile"
        @cycle-theme="cycleTheme"
        @reveal-file="revealCurrentFile"
        @open-external="openCurrentFileExternally"
        @load-file="loadMarkdownFile"
        @remove-recent="removeRecentPath"
        @exit-app="handleExitApp"
      />

      <!-- 右侧主阅读/编辑视口 -->
      <section class="flex flex-1 min-w-0 flex-col h-full relative">
        <!-- 导航 Toolbar -->
        <header
          class="flex h-14 shrink-0 items-center justify-between border-b px-4 bg-background/80 backdrop-blur-md sticky top-0 z-20"
        >
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
            <div
              v-if="isEditing"
              class="flex items-center gap-1.5 mr-2 px-2 h-7 rounded-md bg-muted/50 text-[10px] select-none transition-all duration-300"
            >
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

            <!-- 编辑布局切换 -->
            <div v-if="isEditing" class="flex items-center bg-muted/50 rounded-lg p-0.5 mr-2 animate-fade-in">
              <button
                :class="[
                  'p-1.5 rounded-md cursor-pointer transition',
                  editLayoutMode === 'split' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
                ]"
                @click="editLayoutMode = 'split'"
                title="双栏分屏"
              >
                <Columns class="size-3.5" />
              </button>
              <button
                :class="[
                  'p-1.5 rounded-md cursor-pointer transition',
                  editLayoutMode === 'edit' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
                ]"
                @click="editLayoutMode = 'edit'"
                title="仅展示编辑"
              >
                <Edit class="size-3.5" />
              </button>
              <button
                :class="[
                  'p-1.5 rounded-md cursor-pointer transition',
                  editLayoutMode === 'preview' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
                ]"
                @click="editLayoutMode = 'preview'"
                title="只看预览"
              >
                <Eye class="size-3.5" />
              </button>
            </div>

            <!-- 字号调节 -->
            <div v-if="currentDocument" class="hidden sm:flex items-center bg-muted/50 rounded-lg p-0.5 mr-1 select-none">
              <span class="px-1 text-muted-foreground/60 flex items-center" title="字号调节">
                <Type class="size-3" />
              </span>
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

            <!-- 宽屏排版切换 -->
            <Button
              v-if="currentDocument"
              variant="ghost"
              size="icon"
              class="size-8 cursor-pointer rounded-lg text-muted-foreground hover:text-foreground"
              @click="toggleWideMode"
              :title="isWideMode ? '切换为黄金阅读宽度' : '切换为沉浸宽屏排版'"
            >
              <Minimize2 v-if="isWideMode" class="size-4 text-primary" />
              <Maximize2 v-else class="size-4" />
            </Button>

            <!-- 目录大纲开关 -->
            <Button
              variant="ghost"
              size="icon"
              :class="['size-8 cursor-pointer rounded-lg transition', isTocOpen ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground']"
              @click="isTocOpen = !isTocOpen"
              title="切换大纲目录"
            >
              <List class="size-4" />
            </Button>

            <!-- 编辑模式开关 -->
            <Button
              variant="ghost"
              size="icon"
              :class="['size-8 cursor-pointer rounded-lg transition', isEditing ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground']"
              @click="toggleEditMode"
              title="进入编辑模式 (⌘E)"
            >
              <Edit class="size-4" />
            </Button>

            <Separator orientation="vertical" class="h-4 mx-0.5" />

            <!-- 顶部菜单栏图标显示开关 -->
            <Button
              variant="ghost"
              size="icon"
              :disabled="isTogglingTray"
              :class="['size-8 cursor-pointer rounded-lg transition', showTrayIcon ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground']"
              @click="toggleTrayIcon"
              :title="showTrayIcon ? '隐藏顶部菜单栏图标' : '显示顶部菜单栏图标'"
              :aria-label="showTrayIcon ? '隐藏顶部菜单栏图标' : '显示顶部菜单栏图标'"
              :aria-pressed="showTrayIcon"
            >
              <PanelTop v-if="showTrayIcon" class="size-4" />
              <PanelTopDashed v-else class="size-4" />
            </Button>
          </div>
        </header>

        <!-- 浮动搜索栏组件 (⌘F) -->
        <SearchBar
          :show="showSearch"
          v-model="searchQuery"
          :current-match="currentMatchIndex"
          :total-matches="totalSearchMatches"
          :is-case-sensitive="isCaseSensitive"
          @toggle-case-sensitive="toggleCaseSensitive"
          @next="handleSearchNext"
          @prev="handleSearchPrev"
          @close="handleSearchClose"
        />

        <!-- 外部文件更新通知条 (Live Reload) -->
        <div
          v-if="liveReloadNotice"
          class="bg-primary text-primary-foreground text-xs py-1.5 px-4 text-center shrink-0 shadow-sm animate-in fade-in slide-in-from-top duration-200"
        >
          {{ liveReloadNotice }}
        </div>

        <!-- 视图主体内容 -->
        <div ref="workspaceRef" class="flex flex-1 min-h-0 relative overflow-hidden">
          <!-- 欢迎页空状态 -->
          <div
            v-if="!currentDocument"
            class="flex-1 flex flex-col items-center justify-center p-8 text-center animate-fade-in"
          >
            <div class="size-16 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mb-4 shadow-sm">
              <FileText class="size-8" />
            </div>
            <h3 class="text-lg font-semibold tracking-tight">开启专注阅读之旅</h3>
            <p class="text-sm text-muted-foreground mt-1 max-w-sm">
              从左侧侧边栏打开本地 Markdown 文件，或直接将 .md 文件拖入窗口
            </p>
            <div class="flex items-center gap-3 mt-6">
              <Button @click="pickMarkdownFile" class="cursor-pointer">打开本地文件</Button>
              <Button variant="outline" @click="loadSampleDocument" class="cursor-pointer">阅读使用指南</Button>
            </div>
          </div>

          <!-- 阅读与编辑视口 -->
          <template v-else>
            <!-- 编辑与预览主区域（均分空间，不因右侧大纲挤压而失衡） -->
            <div class="flex flex-1 min-w-0 h-full overflow-hidden">
              <!-- 1. 编辑器区（带搜索背景高亮镜像层） -->
              <div
                v-if="isEditing && (editLayoutMode === 'split' || editLayoutMode === 'edit')"
                :class="[
                  'relative flex flex-col min-w-0 h-full overflow-hidden',
                  editLayoutMode === 'split' ? 'flex-1 border-r border-border/50 bg-background' : 'w-full',
                ]"
              >
                <div
                  v-if="editorBackdropHtml"
                  ref="editorBackdropRef"
                  aria-hidden="true"
                  class="absolute inset-0 overflow-hidden pointer-events-none select-none"
                >
                  <div
                    :style="editorClientWidth ? { width: `${editorClientWidth}px` } : undefined"
                    :class="['editor-mirror-shared text-transparent', editorPaddingClass]"
                    v-html="editorBackdropHtml"
                  ></div>
                </div>
                <textarea
                  ref="textareaRef"
                  :class="[
                    'relative z-10 flex-1 w-full resize-none editor-mirror-shared bg-transparent text-foreground focus:outline-none scroll-container',
                    editorPaddingClass,
                  ]"
                  v-model="rawMarkdown"
                  @input="onEditorInput"
                  @scroll="onEditorScroll"
                  @keydown.tab.prevent="handleTextareaTab"
                  @click="handleEditorInteraction(true)"
                  @keyup="handleEditorInteraction(true)"
                  @mouseup="handleEditorInteraction(false)"
                  @select="handleEditorInteraction(false)"
                  placeholder="开始编写 Markdown..."
                  spellcheck="false"
                ></textarea>
              </div>

              <!-- 2. 阅读主视图容器 (relative 独立隔离回到顶部按钮) -->
              <div
                v-if="!isEditing || editLayoutMode === 'split' || editLayoutMode === 'preview'"
                :class="[
                  'relative flex-1 flex flex-col min-w-0 h-full overflow-hidden',
                  isEditing && editLayoutMode === 'split' ? 'bg-muted/5' : '',
                ]"
              >
                <div
                  ref="previewContainerRef"
                  class="flex-1 overflow-y-auto scroll-container select-text relative"
                  @scroll="onContainerScroll"
                >
                  <div :class="['max-w-none w-full', isSplitEdit ? 'px-5 md:px-8 py-8' : 'px-6 md:px-12 py-10']">
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
                </div>

                <!-- 回到顶部按钮：相对于阅读视口定位在右下角，绝不与 TOC 重叠 -->
                <button
                  v-if="showBackToTop"
                  class="back-to-top-btn absolute bottom-6 right-6 z-30 size-9 rounded-full bg-primary/90 text-primary-foreground shadow-lg flex items-center justify-center hover:bg-primary cursor-pointer transition-all duration-200"
                  @click="scrollToTop"
                  title="回到顶部"
                >
                  <ArrowUp class="size-4" />
                </button>
              </div>
            </div>

            <!-- 3. 右侧大纲目录组件（编辑与阅读模式均可展示，窄屏分栏时自动切换浮层不挤压视口） -->
            <TocPanel
              :is-open="isTocOpen"
              :toc="toc"
              :active-heading-id="activeHeadingId"
              :compact="isTocCompact"
              :overlay="isTocOverlay"
              @select="handleTocSelect"
              @close="isTocOpen = false"
            />
          </template>
        </div>
      </section>
    </main>

    <!-- 拆分组件：图片 Lightbox 全屏预览 -->
    <ImageLightbox :image="lightboxImage" @close="closeLightbox" />
  </div>
</template>
