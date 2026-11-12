import { ref, watch } from "vue"

export function useEditorDebounce(initialContent: string = "", debounceMs = 200) {
  // rawMarkdown 专供 textarea 实时无延迟双向绑定
  const rawMarkdown = ref(initialContent)
  // debouncedMarkdown 用于全量 Markdown 渲染、TOC 提取与字符统计
  const debouncedMarkdown = ref(initialContent)

  let timer: number | null = null

  watch(rawMarkdown, (newVal) => {
    if (timer !== null) {
      window.clearTimeout(timer)
    }
    timer = window.setTimeout(() => {
      debouncedMarkdown.value = newVal
      timer = null
    }, debounceMs)
  })

  /**
   * 立即强制同步（用于打开文件、新建文件或强存时跳过防抖）
   */
  function forceFlushSync(newContent?: string) {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
    if (newContent !== undefined) {
      rawMarkdown.value = newContent
      debouncedMarkdown.value = newContent
    } else {
      debouncedMarkdown.value = rawMarkdown.value
    }
  }

  return {
    rawMarkdown,
    debouncedMarkdown,
    forceFlushSync,
  }
}
