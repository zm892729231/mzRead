import { computed, nextTick, ref, type Ref } from "vue"
import { findElementForLine } from "@/composables/useEditorPreviewSync"

export interface EditorMatch {
  start: number
  end: number
  line: number
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function useSearch(
  articleRef: Ref<HTMLElement | null>,
  rawMarkdown: Ref<string>,
  isEditing: Ref<boolean>,
  editLayoutMode: Ref<"split" | "edit" | "preview">,
  textareaRef: Ref<HTMLTextAreaElement | null>,
  editorBackdropRef: Ref<HTMLElement | null>,
  previewContainerRef: Ref<HTMLElement | null>,
) {
  const showSearch = ref(false)
  const searchQuery = ref("")
  const isCaseSensitive = ref(false)
  const currentMatchIndex = ref(-1)

  const searchMatches = ref<HTMLElement[]>([])
  const editorMatches = ref<EditorMatch[]>([])

  // 编辑模式（分栏或纯编辑）下优先搜索编辑区源码
  const isEditorSearchMode = computed(
    () => isEditing.value && (editLayoutMode.value === "split" || editLayoutMode.value === "edit"),
  )

  const totalMatches = computed(() =>
    isEditorSearchMode.value ? editorMatches.value.length : searchMatches.value.length,
  )

  // 生成编辑器背景层高亮 HTML，确保输入搜索时无需抢占焦点即可实时显示全部匹配与当前项
  const editorBackdropHtml = computed(() => {
    if (!showSearch.value || !isEditorSearchMode.value || editorMatches.value.length === 0) {
      return ""
    }
    const text = rawMarkdown.value
    const parts: string[] = []
    let cursor = 0

    editorMatches.value.forEach((m, idx) => {
      if (m.start > cursor) {
        parts.push(escapeHtml(text.slice(cursor, m.start)))
      }
      const cls =
        idx === currentMatchIndex.value
          ? "editor-search-highlight editor-search-highlight-current"
          : "editor-search-highlight"
      parts.push(`<mark class="${cls}">${escapeHtml(text.slice(m.start, m.end))}</mark>`)
      cursor = m.end
    })

    if (cursor < text.length) {
      parts.push(escapeHtml(text.slice(cursor)))
    }
    // 保留末尾空行高度，与 textarea 滚动高度保持一致
    if (text.endsWith("\n")) {
      parts.push(" ")
    }
    return parts.join("")
  })

  function clearHighlights(root: HTMLElement) {
    const marks = root.querySelectorAll("mark.search-highlight")
    marks.forEach((mark) => {
      const parent = mark.parentNode
      if (!parent) return
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark)
      }
      parent.removeChild(mark)
      parent.normalize()
    })
  }

  function highlightDOM(root: HTMLElement, query: string, caseSensitive: boolean): HTMLElement[] {
    const marks: HTMLElement[] = []
    if (!query) return marks

    const flags = caseSensitive ? "g" : "gi"
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const regex = new RegExp(escaped, flags)

    function walk(node: Node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || ""
        regex.lastIndex = 0
        let match: RegExpExecArray | null

        const parts: Node[] = []
        let lastIdx = 0

        while ((match = regex.exec(text)) !== null) {
          if (match.index > lastIdx) {
            parts.push(document.createTextNode(text.substring(lastIdx, match.index)))
          }
          const mark = document.createElement("mark")
          mark.className = "search-highlight"
          mark.textContent = match[0]
          parts.push(mark)
          marks.push(mark)
          lastIdx = regex.lastIndex
          if (regex.lastIndex === 0) break
        }

        if (parts.length > 0) {
          if (lastIdx < text.length) {
            parts.push(document.createTextNode(text.substring(lastIdx)))
          }
          const parent = node.parentNode
          if (parent) {
            for (const part of parts) {
              parent.insertBefore(part, node)
            }
            parent.removeChild(node)
          }
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element
        if (
          ["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "BUTTON", "MARK", "SVG"].includes(el.tagName) ||
          el.classList.contains("katex-mathml") ||
          el.classList.contains("mermaid") ||
          el.classList.contains("code-lang-badge") ||
          el.classList.contains("copy-code-btn")
        ) {
          return
        }
        const children = Array.from(node.childNodes)
        for (const child of children) {
          walk(child)
        }
      }
    }

    walk(root)
    return marks
  }

  function findEditorMatches(text: string, query: string, caseSensitive: boolean): EditorMatch[] {
    const searchTarget = caseSensitive ? text : text.toLowerCase()
    const searchNeedle = caseSensitive ? query : query.toLowerCase()
    const matchesList: EditorMatch[] = []

    let pos = searchTarget.indexOf(searchNeedle)
    let line = 0
    let lastPos = 0

    while (pos !== -1) {
      for (let i = lastPos; i < pos; i++) {
        if (text.charCodeAt(i) === 10) line++
      }
      lastPos = pos
      matchesList.push({
        start: pos,
        end: pos + query.length,
        line,
      })
      pos = searchTarget.indexOf(searchNeedle, pos + Math.max(1, searchNeedle.length))
    }

    return matchesList
  }

  function syncPreviewMatchForEditor(match: EditorMatch, scrollToCurrent: boolean) {
    searchMatches.value.forEach((mark) => {
      mark.className = "search-highlight"
    })

    const preview = previewContainerRef.value
    if (!preview || editLayoutMode.value !== "split") return

    const targetBlock = findElementForLine(preview, match.line)
    if (!targetBlock) return

    const blockStart = Number(targetBlock.getAttribute("data-line") ?? match.line)
    const blockEnd = Number(targetBlock.getAttribute("data-line-end") ?? blockStart + 1)

    // 计算当前匹配是该源码块中的第几个匹配，尽量对齐同一块内的多个匹配项
    let indexInBlock = 0
    for (let i = 0; i < currentMatchIndex.value; i++) {
      const prev = editorMatches.value[i]
      if (prev.line >= blockStart && prev.line < blockEnd) {
        indexInBlock++
      }
    }

    const blockMarks = searchMatches.value.filter((mark) => targetBlock.contains(mark))
    const activePreviewMark =
      blockMarks.length > 0
        ? blockMarks[Math.min(indexInBlock, blockMarks.length - 1)]
        : null

    if (activePreviewMark) {
      activePreviewMark.className = "search-highlight search-highlight-current"
      if (scrollToCurrent) {
        activePreviewMark.scrollIntoView({ behavior: "smooth", block: "center" })
      }
    } else if (scrollToCurrent) {
      targetBlock.scrollIntoView({ behavior: "smooth", block: "center" })
    }
  }

  function highlightCurrentMatch(scrollToCurrent = true) {
    if (isEditorSearchMode.value) {
      const match = editorMatches.value[currentMatchIndex.value]
      if (!match) return

      nextTick(() => {
        const backdrop = editorBackdropRef.value
        const textarea = textareaRef.value
        if (backdrop && textarea) {
          backdrop.scrollTop = textarea.scrollTop
          backdrop.scrollLeft = textarea.scrollLeft

          if (scrollToCurrent) {
            const activeMark = backdrop.querySelector<HTMLElement>(".editor-search-highlight-current")
            if (activeMark) {
              const markRect = activeMark.getBoundingClientRect()
              const backdropRect = backdrop.getBoundingClientRect()
              const relativeTop = markRect.top - backdropRect.top + backdrop.scrollTop
              const targetTop = relativeTop - textarea.clientHeight / 2 + markRect.height / 2
              textarea.scrollTo({
                top: Math.max(0, targetTop),
                behavior: "smooth",
              })
            }
          }
        }
      })

      syncPreviewMatchForEditor(match, scrollToCurrent)
      return
    }

    searchMatches.value.forEach((mark, idx) => {
      if (idx === currentMatchIndex.value) {
        mark.className = "search-highlight search-highlight-current"
        if (scrollToCurrent) {
          mark.scrollIntoView({ behavior: "smooth", block: "center" })
        }
      } else {
        mark.className = "search-highlight"
      }
    })
  }

  function performSearch(options: { scrollToCurrent?: boolean } = {}) {
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

    if (articleRef.value) {
      searchMatches.value = highlightDOM(articleRef.value, query, isCaseSensitive.value)
    }

    if (rawMarkdown.value && isEditorSearchMode.value) {
      editorMatches.value = findEditorMatches(rawMarkdown.value, query, isCaseSensitive.value)
    }

    const total = totalMatches.value
    if (total > 0) {
      if (currentMatchIndex.value < 0 || currentMatchIndex.value >= total) {
        currentMatchIndex.value = 0
      }
      highlightCurrentMatch(options.scrollToCurrent ?? true)
    } else {
      currentMatchIndex.value = -1
    }
  }

  function handleSearchNext() {
    const total = totalMatches.value
    if (total === 0) return
    currentMatchIndex.value = (currentMatchIndex.value + 1) % total
    highlightCurrentMatch(true)
  }

  function handleSearchPrev() {
    const total = totalMatches.value
    if (total === 0) return
    currentMatchIndex.value = (currentMatchIndex.value - 1 + total) % total
    highlightCurrentMatch(true)
  }

  function toggleCaseSensitive() {
    isCaseSensitive.value = !isCaseSensitive.value
    performSearch({ scrollToCurrent: true })
  }

  function closeSearch(options: { focusEditor?: boolean } = {}) {
    const shouldFocusMatch =
      options.focusEditor &&
      isEditorSearchMode.value &&
      currentMatchIndex.value >= 0 &&
      currentMatchIndex.value < editorMatches.value.length

    const activeMatch = shouldFocusMatch ? editorMatches.value[currentMatchIndex.value] : null

    showSearch.value = false
    searchQuery.value = ""
    if (articleRef.value) {
      clearHighlights(articleRef.value)
    }
    searchMatches.value = []
    editorMatches.value = []
    currentMatchIndex.value = -1

    if (activeMatch && textareaRef.value) {
      const textarea = textareaRef.value
      nextTick(() => {
        textarea.focus()
        textarea.setSelectionRange(activeMatch.start, activeMatch.end)
      })
    }
  }

  function openSearch() {
    showSearch.value = true
  }

  return {
    showSearch,
    searchQuery,
    isCaseSensitive,
    currentMatchIndex,
    searchMatches,
    editorMatches,
    totalMatches,
    editorBackdropHtml,
    isEditorSearchMode,
    performSearch,
    handleSearchNext,
    handleSearchPrev,
    toggleCaseSensitive,
    closeSearch,
    openSearch,
  }
}
