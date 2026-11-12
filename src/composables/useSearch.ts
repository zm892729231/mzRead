import { ref, type Ref } from "vue"

export interface EditorMatch {
  start: number
  end: number
}

export function useSearch(
  articleRef: Ref<HTMLElement | null>,
  rawMarkdown: Ref<string>,
  isEditing: Ref<boolean>,
  editLayoutMode: Ref<"split" | "edit" | "preview">,
) {
  const showSearch = ref(false)
  const searchQuery = ref("")
  const isCaseSensitive = ref(false)
  const currentMatchIndex = ref(-1)

  const searchMatches = ref<HTMLElement[]>([])
  const editorMatches = ref<EditorMatch[]>([])

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
      } else if (
        node.nodeType === Node.ELEMENT_NODE &&
        !["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "MARK"].includes((node as Element).tagName)
      ) {
        const children = Array.from(node.childNodes)
        for (const child of children) {
          walk(child)
        }
      }
    }

    walk(root)
    return marks
  }

  function performSearch(options: { selectInEditor?: boolean } = {}) {
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

    // 1. 预览区 DOM 文本搜索
    if (articleRef.value) {
      searchMatches.value = highlightDOM(articleRef.value, query, isCaseSensitive.value)
    }

    // 2. 编辑器区域源码搜索
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
      highlightCurrentMatch(options.selectInEditor ?? false)
    } else {
      currentMatchIndex.value = -1
    }
  }

  function highlightCurrentMatch(selectInEditor = false) {
    searchMatches.value.forEach((mark, idx) => {
      if (idx === currentMatchIndex.value) {
        mark.className = "search-highlight search-highlight-current"
        mark.scrollIntoView({ behavior: "smooth", block: "center" })
      } else {
        mark.className = "search-highlight"
      }
    })

    // 仅在显式请求（例如点击上一个/下一个）且处于编辑模式时才联动选中文本域，打字触发时决不能抢焦点！
    if (
      selectInEditor &&
      isEditing.value &&
      (editLayoutMode.value === "split" || editLayoutMode.value === "edit")
    ) {
      if (
        editorMatches.value.length > 0 &&
        currentMatchIndex.value >= 0 &&
        currentMatchIndex.value < editorMatches.value.length
      ) {
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
    highlightCurrentMatch(true)
  }

  function handleSearchPrev() {
    const total = Math.max(searchMatches.value.length, editorMatches.value.length)
    if (total === 0) return
    currentMatchIndex.value = (currentMatchIndex.value - 1 + total) % total
    highlightCurrentMatch(true)
  }

  function toggleCaseSensitive() {
    isCaseSensitive.value = !isCaseSensitive.value
    performSearch({ selectInEditor: false })
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
    performSearch,
    handleSearchNext,
    handleSearchPrev,
    toggleCaseSensitive,
    closeSearch,
    openSearch,
  }
}
