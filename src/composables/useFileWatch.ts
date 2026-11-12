import { onMounted, onUnmounted, type Ref } from "vue"
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

export function useFileWatch(
  currentDoc: Ref<{ path: string; modified_ms: number | null } | null>,
  onFileModified: (path: string) => void,
) {
  let unlistenModified: UnlistenFn | null = null
  let pollIntervalId: number | null = null

  // 1. 注册 Rust 端 notify 文件监听
  async function setupWatch(filePath: string) {
    if (!filePath || filePath === "示例内容") {
      try {
        await invoke("unwatch_file")
      } catch {}
      return
    }
    try {
      await invoke("watch_file", { path: filePath })
    } catch (err) {
      console.warn("启用系统文件监听器失败，将依赖轮询回退:", err)
    }
  }

  // 2. 检查外部更新逻辑（带 document.hidden 保护）
  async function checkExternalUpdate() {
    // 如果窗口处于最小化或后台不可见状态，直接跳过 IPC 查询与磁盘访问
    if (typeof document !== "undefined" && document.hidden) {
      return
    }

    const doc = currentDoc.value
    if (!doc || doc.path === "示例内容" || !doc.modified_ms) return

    try {
      const metadataMap = await invoke<Record<string, number>>("get_files_metadata", {
        paths: [doc.path],
      })
      const latestMs = metadataMap[doc.path]
      if (latestMs && latestMs > doc.modified_ms) {
        onFileModified(doc.path)
      }
    } catch {}
  }

  function onVisibilityChange() {
    if (!document.hidden) {
      // 从后台切回前台时，立即检查一次
      void checkExternalUpdate()
    }
  }

  onMounted(async () => {
    // 监听 Rust 端主动 emit 的零开销文件变动事件
    try {
      unlistenModified = await listen<string>("file-modified", (event) => {
        if (currentDoc.value && currentDoc.value.path !== "示例内容") {
          onFileModified(event.payload)
        }
      })
    } catch (err) {
      console.warn("注册 file-modified 监听失败:", err)
    }

    // 后台轮询兜底，间隔提高到 3000ms（且仅在前台执行）
    pollIntervalId = window.setInterval(checkExternalUpdate, 3000)
    document.addEventListener("visibilitychange", onVisibilityChange)
  })

  onUnmounted(() => {
    if (unlistenModified) {
      unlistenModified()
      unlistenModified = null
    }
    if (pollIntervalId !== null) {
      clearInterval(pollIntervalId)
      pollIntervalId = null
    }
    document.removeEventListener("visibilitychange", onVisibilityChange)
    void invoke("unwatch_file").catch(() => {})
  })

  return {
    setupWatch,
    checkExternalUpdate,
  }
}
