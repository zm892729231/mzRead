import DOMPurify from "dompurify"
import MarkdownIt, { type Options } from "markdown-it"
import type Token from "markdown-it/lib/token.mjs"
import type Renderer from "markdown-it/lib/renderer.mjs"
import hljs from "highlight.js"
import taskLists from "markdown-it-task-lists"
import footnote from "markdown-it-footnote"
import katexPlugin from "@vscode/markdown-it-katex"
import { convertFileSrc } from "@tauri-apps/api/core"

export interface TocItem {
  id: string
  text: string
  level: number
  line: number
}

export interface MarkdownRenderResult {
  html: string
  toc: TocItem[]
}

/**
 * 字符串转义 HTML 特殊字符
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * 判断是否为绝对网络 URL、data URL、asset 协议或协议无关 URL
 */
export function isUrlOrSpecial(path: string): boolean {
  if (!path) return false
  return (
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    path.startsWith("data:") ||
    path.startsWith("asset:") ||
    path.startsWith("blob:") ||
    path.startsWith("//") ||
    path.startsWith("#")
  )
}

/**
 * 从完整文件路径中提取所属目录
 */
export function getDirectoryFromPath(filePath: string): string {
  if (!filePath || filePath === "示例内容") return ""
  const normalized = filePath.replace(/\\/g, "/")
  const lastSlash = normalized.lastIndexOf("/")
  if (lastSlash === -1) return ""
  // 处理 Windows 盘符根目录，如 C:/
  if (lastSlash === 2 && /^[a-zA-Z]:/.test(normalized)) {
    return normalized.slice(0, 3)
  }
  return normalized.slice(0, lastSlash)
}

/**
 * 解析并规范化基准目录与相对路径，返回跨平台的规范绝对路径
 */
export function resolveRelativePath(baseDir: string, relativePath: string): string {
  if (!baseDir) return relativePath
  // 判断是否为 Windows 路径格式（C:/ 或 C:\）
  const isWindows = /^[a-zA-Z]:[\\/]/.test(baseDir)
  const normalizedBase = baseDir.replace(/\\/g, "/").replace(/\/+$/, "")
  const cleanRel = relativePath.split(/[?#]/)[0].replace(/\\/g, "/")

  const baseParts = normalizedBase.split("/")
  const relParts = cleanRel.split("/")

  for (const part of relParts) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (baseParts.length > 1) {
        baseParts.pop()
      }
    } else {
      baseParts.push(part)
    }
  }

  return isWindows ? baseParts.join("\\") : baseParts.join("/")
}

/**
 * 安全地将本地文件绝对路径转换为 asset:// 协议 URL
 */
export function toAssetUrl(filePath: string): string {
  try {
    if (typeof window !== "undefined") {
      return convertFileSrc(filePath)
    }
  } catch {}
  return `asset://localhost/${encodeURI(filePath.replace(/\\/g, "/"))}`
}

/**
 * 环境感知型 DOMPurify 净化函数
 */
function safeSanitize(html: string, options: any): string {
  try {
    if (typeof (DOMPurify as any)?.sanitize === "function") {
      return (DOMPurify as any).sanitize(html, options)
    }
    if (typeof (DOMPurify as any) === "function" && typeof window !== "undefined") {
      return (DOMPurify as any)(window).sanitize(html, options)
    }
  } catch (err) {
    console.warn("DOMPurify 净化警告:", err)
  }
  return html
}
function extractPlainText(inlineToken?: Token): string {
  if (!inlineToken) return ""
  if (!inlineToken.children || inlineToken.children.length === 0) {
    return inlineToken.content || ""
  }
  const text = inlineToken.children
    .filter((child: Token) => child.type === "text" || child.type === "code_inline")
    .map((child: Token) => child.content)
    .join("")
    .trim()
  return text || inlineToken.content || ""
}

// ----------------------------------------------------------------------------
// 初始化 Markdown-It 渲染器
// ----------------------------------------------------------------------------
const renderer: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (str: string, lang: string): string => {
    // 特殊处理 mermaid 语法，交给客户端 mermaid 渲染
    if (lang && lang.trim().toLowerCase() === "mermaid") {
      return `<div class="mermaid">${escapeHtml(str)}</div>`
    }

    // 常用编程语言通过 highlight.js 高亮
    if (lang && hljs.getLanguage(lang)) {
      try {
        const highlighted = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
        return `<pre class="hljs"><code class="language-${escapeHtml(lang)}">${highlighted}</code></pre>`
      } catch {
        // fallback to auto or escape
      }
    }

    // 未指定语言时尝试自动探测高亮
    try {
      const auto = hljs.highlightAuto(str)
      if (auto.language) {
        return `<pre class="hljs"><code class="language-${escapeHtml(auto.language)}">${auto.value}</code></pre>`
      }
    } catch {}

    return `<pre class="hljs"><code>${escapeHtml(str)}</code></pre>`
  },
})

// 1. 注册 Task Lists 任务列表扩展 (- [ ] / - [x])
renderer.use(taskLists, { enabled: true, label: true, labelAfter: true })

// 2. 注册 Footnote 脚注扩展 ([^1])
renderer.use(footnote)

// 3. 注册 KaTeX 数学公式扩展 ($...$ / $$...$$)
const katexPluginFn = (katexPlugin as any).default || katexPlugin
renderer.use(katexPluginFn, { throwOnError: false })

// 4. 行号映射（供预览与源码同步定位使用）
renderer.core.ruler.push("source_map", (state: any) => {
  for (const token of state.tokens) {
    if (token.map && token.type !== "inline") {
      token.attrSet("data-line", String(token.map[0]))
      token.attrSet("data-line-end", String(token.map[1]))
    }
  }
})

function injectSourceLineAttrs(html: string, token: Token): string {
  if (!token.map) return html
  const attrs = ` data-line="${token.map[0]}" data-line-end="${token.map[1]}"`
  return html.replace(/^<(pre|div)(?=[\s>])/, `<$1${attrs}`)
}

const defaultFenceRule =
  renderer.renderer.rules.fence ??
  ((tokens: Token[], idx: number, options: Options, _env: any, self: Renderer) =>
    self.renderToken(tokens, idx, options))

renderer.renderer.rules.fence = (
  tokens: Token[],
  idx: number,
  options: Options,
  env: any,
  self: Renderer,
) => injectSourceLineAttrs(defaultFenceRule(tokens, idx, options, env, self), tokens[idx])

const defaultCodeBlockRule =
  renderer.renderer.rules.code_block ??
  ((tokens: Token[], idx: number, options: Options, _env: any, self: Renderer) =>
    self.renderToken(tokens, idx, options))

renderer.renderer.rules.code_block = (
  tokens: Token[],
  idx: number,
  options: Options,
  env: any,
  self: Renderer,
) => injectSourceLineAttrs(defaultCodeBlockRule(tokens, idx, options, env, self), tokens[idx])

// 5. 链接规则：外部网络链接新窗口打开，锚点和相对链接保持原样供应用内拦截
const defaultLinkOpen =
  renderer.renderer.rules.link_open ??
  ((tokens: Token[], idx: number, options: Options, _env: any, self: Renderer) =>
    self.renderToken(tokens, idx, options))

renderer.renderer.rules.link_open = (
  tokens: Token[],
  idx: number,
  options: Options,
  env: any,
  self: Renderer,
) => {
  const token = tokens[idx]
  const href = token.attrGet("href") || ""

  // 外部网络链接在新窗口打开
  if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")) {
    token.attrSet("target", "_blank")
    token.attrSet("rel", "noreferrer noopener")
  }

  return defaultLinkOpen(tokens, idx, options, env, self)
}

// 6. 本地相对路径图片转 asset:// URL 规则
const defaultImageRule =
  renderer.renderer.rules.image ??
  ((tokens: Token[], idx: number, options: Options, _env: any, self: Renderer) =>
    self.renderToken(tokens, idx, options))

renderer.renderer.rules.image = (
  tokens: Token[],
  idx: number,
  options: Options,
  env: any,
  self: Renderer,
) => {
  const token = tokens[idx]
  const src = token.attrGet("src")
  const docDir = (env as { docDir?: string })?.docDir

  if (src && docDir && !isUrlOrSpecial(src)) {
    try {
      const absolutePath = resolveRelativePath(docDir, src)
      const assetUrl = toAssetUrl(absolutePath)
      token.attrSet("src", assetUrl)
      token.attrSet("data-local-path", absolutePath)
      token.attrSet("data-original-src", src)
    } catch (err) {
      console.warn("解析本地相对图片失败:", src, err)
    }
  }

  return defaultImageRule(tokens, idx, options, env, self)
}

/**
 * 渲染 Markdown 核心方法
 * @param source Markdown 源码字符串
 * @param docPath 当前打开文档的物理绝对路径（用于相对图片与链接解析）
 */
export function renderMarkdown(source: string, docPath?: string): MarkdownRenderResult {
  const docDir = getDirectoryFromPath(docPath || "")
  const env = { docDir }
  const tokens = renderer.parse(source, env)

  let headingCount = 0
  const toc: TocItem[] = []

  // 遍历 AST 提取唯一的 Heading ID，并构建严格对齐的真实 TOC
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === "heading_open") {
      const level = Number(token.tag.slice(1))
      const id = `heading-${headingCount++}`
      token.attrSet("id", id)

      // 下一个 token 为 inline 类型，包含标题文本与格式
      const nextToken = tokens[i + 1]
      const titleText = extractPlainText(nextToken)

      // 只将 H1 ~ H4 纳入大纲目录
      if (level >= 1 && level <= 4) {
        toc.push({
          id,
          text: titleText || `第 ${headingCount} 节`,
          level,
          line: token.map ? token.map[0] : 0,
        })
      }
    }
  }

  const rawHtml = renderer.renderer.render(tokens, renderer.options, env)

  // 使用 DOMPurify 安全过滤，同时保留 MathML、KaTeX、Task Lists 复选框与 asset 协议
  const sanitizedHtml = safeSanitize(rawHtml, {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_TAGS: [
      "input",
      "math",
      "semantics",
      "mrow",
      "mo",
      "mi",
      "mn",
      "annotation",
      "mspace",
      "mtext",
      "mtable",
      "mtr",
      "mtd",
      "svg",
      "path",
      "g",
      "defs",
      "use",
      "marker",
    ],
    ADD_ATTR: [
      "target",
      "rel",
      "id",
      "data-line",
      "data-line-end",
      "class",
      "type",
      "checked",
      "disabled",
      "src",
      "alt",
      "title",
      "data-local-path",
      "data-original-src",
      "aria-hidden",
      "style",
      "display",
      "viewBox",
      "width",
      "height",
      "fill",
      "stroke",
      "stroke-width",
      "stroke-linecap",
      "stroke-linejoin",
      "d",
    ],
    FORBID_TAGS: [
      "button",
      "embed",
      "form",
      "iframe",
      "object",
      "option",
      "script",
      "select",
      "textarea",
    ],
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|asset|http:\/\/asset\.localhost):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  })

  return {
    html: sanitizedHtml,
    toc,
  }
}
