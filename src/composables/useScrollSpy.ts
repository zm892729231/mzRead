import { ref, type Ref } from "vue"

export function useScrollSpy(
  previewContainerRef: Ref<HTMLElement | null>,
  articleRef: Ref<HTMLElement | null>,
  currentDocPath: Ref<string | undefined>,
  onRecordScroll?: (path: string, top: number) => void,
) {
  const activeHeadingId = ref<string | null>(null)
  const readingProgress = ref(0)
  const showBackToTop = ref(false)

  let cachedHeadings: HTMLElement[] = []
  let scrollRafId: number | null = null

  // 更新缓存的标题引用，避免在滚动事件里频繁 querySelectorAll
  function updateCachedHeadings() {
    if (!articleRef.value) {
      cachedHeadings = []
      return
    }
    cachedHeadings = Array.from(
      articleRef.value.querySelectorAll<HTMLElement>("h1, h2, h3, h4"),
    )
  }

  function handleScroll() {
    const container = previewContainerRef.value
    if (!container) return

    const { scrollTop, scrollHeight, clientHeight } = container
    showBackToTop.value = scrollTop > 320

    const maxScroll = scrollHeight - clientHeight
    readingProgress.value =
      maxScroll > 0 ? Math.min(100, Math.max(0, (scrollTop / maxScroll) * 100)) : 0

    if (currentDocPath.value && onRecordScroll) {
      onRecordScroll(currentDocPath.value, scrollTop)
    }

    if (cachedHeadings.length === 0) {
      updateCachedHeadings()
    }
    if (cachedHeadings.length === 0) return

    const containerRect = container.getBoundingClientRect()
    let currentActiveId: string | null = null

    for (const el of cachedHeadings) {
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
    } else if (cachedHeadings[0]) {
      activeHeadingId.value = cachedHeadings[0].id
    }
  }

  // 使用 requestAnimationFrame 对滚动事件进行节流
  function onContainerScroll() {
    if (scrollRafId !== null) return
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null
      handleScroll()
    })
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

  return {
    activeHeadingId,
    readingProgress,
    showBackToTop,
    updateCachedHeadings,
    handleScroll,
    onContainerScroll,
    scrollToTop,
    scrollToHeading,
  }
}
