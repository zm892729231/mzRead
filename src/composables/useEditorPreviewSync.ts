import type { Ref } from "vue"

const SELECTION_MARK_CLASS = "preview-selection-highlight"
const BLOCK_SELECTED_CLASS = "preview-block-selected"

/**
 * 计算源码中每一行（0-indexed）的起始字符偏移量，末尾附加总长度作为哨兵
 */
export function computeLineOffsets(source: string): number[] {
  const offsets: number[] = [0]
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      offsets.push(i + 1)
    }
  }
  offsets.push(source.length)
  return offsets
}

/**
 * 根据字符偏移量二分查找对应的 0-indexed 行号
 */
export function getLineAtOffset(offsets: number[], offset: number): number {
  let lo = 0
  let hi = offsets.length - 2
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] <= offset) {
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return Math.max(0, hi)
}

/**
 * 在预览 DOM 中查找对应源码行号的最内层块级元素
 */
export function findElementForLine(previewRoot: HTMLElement, line: number): HTMLElement | null {
  const elements = Array.from(previewRoot.querySelectorAll<HTMLElement>("[data-line]"))
  if (elements.length === 0) return null

  let bestContain: HTMLElement | null = null
  let bestSpan = Infinity
  let nearestBefore: HTMLElement | null = null
  let nearestBeforeLine = -1

  for (const el of elements) {
    const start = Number(el.getAttribute("data-line"))
    if (Number.isNaN(start)) continue
    const endAttr = el.getAttribute("data-line-end")
    const end = endAttr !== null ? Number(endAttr) : start + 1

    if (start <= line && line < end) {
      const span = Math.max(1, end - start)
      if (span <= bestSpan) {
        bestSpan = span
        bestContain = el
      }
    } else if (start <= line && start >= nearestBeforeLine) {
      nearestBeforeLine = start
      nearestBefore = el
    }
  }

  return bestContain ?? nearestBefore ?? elements[0]
}

/**
 * 查找与源码行区间 [startLine, endLine] 重叠的最内层块级元素列表
 */
export function findBlocksForLineRange(
  previewRoot: HTMLElement,
  startLine: number,
  endLine: number,
): HTMLElement[] {
  const elements = Array.from(previewRoot.querySelectorAll<HTMLElement>("[data-line]"))
  const overlapping: HTMLElement[] = []

  for (const el of elements) {
    const elStart = Number(el.getAttribute("data-line"))
    if (Number.isNaN(elStart)) continue
    const endAttr = el.getAttribute("data-line-end")
    const elEnd = endAttr !== null ? Number(endAttr) : elStart + 1

    if (elStart <= endLine && elEnd > startLine) {
      overlapping.push(el)
    }
  }

  // 仅保留最内层块级元素，避免选中单个列表项时连带高亮整个列表容器
  return overlapping.filter(
    (el) => !overlapping.some((other) => other !== el && el.contains(other)),
  )
}

/**
 * 去除常见的行内与块级 Markdown 语法标记，保留纯文本用于和渲染 DOM 对齐
 */
function stripMarkdownSyntax(raw: string, isTableRow: boolean): string {
  let text = raw
    .replace(/^[ \t]{0,3}```[^\n]*\n?/gm, "")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/^[ \t]*\d+\.[ \t]+/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\*/g, "")
    // 仅移除词边界的斜体下划线，避免破坏 foo_bar 变量名
    .replace(/(^|[^\w])_+|_+([^\w]|$)/g, "$1$2")

  if (isTableRow) {
    text = text.replace(/^\s*\||\|\s*$/gm, "").replace(/\s*\|\s*/g, " ")
  }
  return text
}

function collectVisibleTextSegments(root: HTMLElement) {
  const segments: { node: Text; start: number; end: number }[] = []
  let fullText = ""

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || ""
      if (text.length > 0) {
        const start = fullText.length
        fullText += text
        segments.push({ node: node as Text, start, end: fullText.length })
      }
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return

    const el = node as HTMLElement
    const tag = el.tagName
    if (
      tag === "SCRIPT" ||
      tag === "STYLE" ||
      tag === "TEXTAREA" ||
      tag === "INPUT" ||
      tag === "BUTTON" ||
      tag === "SVG" ||
      el.classList.contains(SELECTION_MARK_CLASS) ||
      el.classList.contains("katex") ||
      el.classList.contains("mermaid") ||
      el.classList.contains("code-lang-badge") ||
      el.classList.contains("copy-code-btn")
    ) {
      return
    }

    for (const child of Array.from(el.childNodes)) {
      walk(child)
    }
  }

  walk(root)
  return { segments, fullText }
}

function buildFlexibleWhitespaceRegex(query: string): RegExp | null {
  const trimmed = query.trim()
  if (!trimmed) return null
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*")
  return new RegExp(pattern, "g")
}

function wrapRangeInSegments(
  segments: { node: Text; start: number; end: number }[],
  matchStart: number,
  matchEnd: number,
): HTMLElement[] {
  const created: HTMLElement[] = []

  for (const seg of segments) {
    if (seg.end <= matchStart || seg.start >= matchEnd) continue
    const node = seg.node
    const parent = node.parentNode
    if (!parent) continue

    const localStart = Math.max(0, matchStart - seg.start)
    const localEnd = Math.min(node.length, matchEnd - seg.start)
    if (localStart >= localEnd) continue

    const fullVal = node.nodeValue || ""
    const before = fullVal.slice(0, localStart)
    const middle = fullVal.slice(localStart, localEnd)
    const after = fullVal.slice(localEnd)

    const frag = document.createDocumentFragment()
    if (before) frag.appendChild(document.createTextNode(before))
    const mark = document.createElement("mark")
    mark.className = SELECTION_MARK_CLASS
    mark.textContent = middle
    frag.appendChild(mark)
    created.push(mark)
    if (after) frag.appendChild(document.createTextNode(after))

    parent.replaceChild(frag, node)
  }

  return created
}

function tryMatchAndHighlight(
  block: HTMLElement,
  query: string,
  preferredRatio: number,
): HTMLElement[] {
  const regex = buildFlexibleWhitespaceRegex(query)
  if (!regex) return []

  const { segments, fullText } = collectVisibleTextSegments(block)
  if (!fullText) return []

  const candidates: { start: number; end: number }[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(fullText)) !== null) {
    if (match[0].length === 0) break
    candidates.push({ start: match.index, end: match.index + match[0].length })
  }

  if (candidates.length === 0) return []

  // 若块内存在多次相同文本匹配，按选区在源码块中的相对位置挑选最接近的那一处
  let best = candidates[0]
  if (candidates.length > 1) {
    let bestDist = Infinity
    for (const c of candidates) {
      const ratio = c.start / Math.max(1, fullText.length)
      const dist = Math.abs(ratio - preferredRatio)
      if (dist < bestDist) {
        bestDist = dist
        best = c
      }
    }
  }

  return wrapRangeInSegments(segments, best.start, best.end)
}

function highlightBlockForSource(
  block: HTMLElement,
  subSource: string,
  preferredRatio: number,
): HTMLElement[] {
  const isTableRow = block.tagName === "TR" || block.tagName === "TABLE"
  const cleanRaw = subSource.replace(/^[ \t]{0,3}```[^\n]*\n?|\n?[ \t]{0,3}```\s*$/g, "")

  // 1. 先尝试原文直接匹配（兼容代码块、含下划线变量等）
  let marks = tryMatchAndHighlight(block, cleanRaw, preferredRatio)
  if (marks.length > 0) return marks

  // 2. 再尝试剥离 Markdown 语法后整段匹配
  const stripped = stripMarkdownSyntax(subSource, isTableRow)
  marks = tryMatchAndHighlight(block, stripped, preferredRatio)
  if (marks.length > 0) return marks

  // 3. 若多行混合语法无法整段匹配，则逐行尝试高亮
  const lines = stripped.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length > 1) {
    const allCreated: HTMLElement[] = []
    for (const lineText of lines) {
      const lineMarks = tryMatchAndHighlight(block, lineText, preferredRatio)
      allCreated.push(...lineMarks)
    }
    return allCreated
  }

  return []
}

function isElementInContainerViewport(el: HTMLElement, container: HTMLElement): boolean {
  const elRect = el.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  return elRect.top >= containerRect.top + 16 && elRect.bottom <= containerRect.bottom - 16
}

export function useEditorPreviewSync(
  rawMarkdown: Ref<string>,
  textareaRef: Ref<HTMLTextAreaElement | null>,
  previewContainerRef: Ref<HTMLElement | null>,
  articleRef: Ref<HTMLElement | null>,
  isEditing: Ref<boolean>,
  editLayoutMode: Ref<"split" | "edit" | "preview">,
) {
  function clearPreviewSelection() {
    const root = articleRef.value
    if (!root) return

    root.querySelectorAll(`.${BLOCK_SELECTED_CLASS}`).forEach((el) => {
      el.classList.remove(BLOCK_SELECTED_CLASS)
    })

    const marks = root.querySelectorAll(`mark.${SELECTION_MARK_CLASS}`)
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

  function syncPreviewToCursorLine(line: number, behavior: ScrollBehavior = "smooth") {
    if (!isEditing.value || editLayoutMode.value !== "split") return
    const preview = previewContainerRef.value
    if (!preview) return
    const targetEl = findElementForLine(preview, line)
    if (targetEl) {
      targetEl.scrollIntoView({ behavior, block: "center" })
    }
  }

  function syncPreviewToSelection(options: { scrollIfOutOfView?: boolean; syncCursorScroll?: boolean } = {}) {
    if (!isEditing.value || editLayoutMode.value !== "split") {
      clearPreviewSelection()
      return
    }

    const textarea = textareaRef.value
    const preview = previewContainerRef.value
    const article = articleRef.value
    if (!textarea || !preview || !article) return

    const start = textarea.selectionStart
    const end = textarea.selectionEnd

    clearPreviewSelection()

    const offsets = computeLineOffsets(rawMarkdown.value)
    const startLine = getLineAtOffset(offsets, start)

    // 仅光标点击/移动，无文本选区
    if (start === end) {
      if (options.syncCursorScroll) {
        syncPreviewToCursorLine(startLine)
      }
      return
    }

    let endLine = getLineAtOffset(offsets, end)
    // 若选区终点刚好停在下一行第 0 列，不把下一行纳入选区范围
    if (endLine > startLine && end === offsets[endLine]) {
      endLine -= 1
    }

    const blocks = findBlocksForLineRange(article, startLine, endLine)
    if (blocks.length === 0) return

    let firstHighlighted: HTMLElement | null = null
    // 大范围全选（如 Cmd+A）时超过 25 个块改用块级高亮，避免大文档 DOM 节点拆分卡顿
    const useTextLevelHighlight = blocks.length <= 25

    for (const block of blocks) {
      const bStart = Number(block.getAttribute("data-line"))
      const bEndAttr = block.getAttribute("data-line-end")
      const bEnd = bEndAttr !== null ? Number(bEndAttr) : bStart + 1

      const bCharStart = offsets[Math.min(bStart, offsets.length - 1)]
      const bCharEnd = offsets[Math.min(bEnd, offsets.length - 1)]
      const subStart = Math.max(start, bCharStart)
      const subEnd = Math.min(end, bCharEnd)
      const subSource = rawMarkdown.value.slice(subStart, subEnd)

      if (!subSource.trim()) continue

      if (!useTextLevelHighlight) {
        block.classList.add(BLOCK_SELECTED_CLASS)
        if (!firstHighlighted) firstHighlighted = block
        continue
      }

      const preferredRatio = (subStart - bCharStart) / Math.max(1, bCharEnd - bCharStart)
      const createdMarks = highlightBlockForSource(block, subSource, preferredRatio)

      if (createdMarks.length > 0) {
        if (!firstHighlighted) firstHighlighted = createdMarks[0]
      } else {
        // 对于 Mermaid、KaTeX 公式块或图片等不可拆分的块级元素，使用块级高亮
        block.classList.add(BLOCK_SELECTED_CLASS)
        if (!firstHighlighted) firstHighlighted = block
      }
    }

    if ((options.scrollIfOutOfView ?? true) && firstHighlighted && !isElementInContainerViewport(firstHighlighted, preview)) {
      firstHighlighted.scrollIntoView({ behavior: "smooth", block: "nearest" })
    }
  }

  return {
    clearPreviewSelection,
    syncPreviewToCursorLine,
    syncPreviewToSelection,
  }
}
