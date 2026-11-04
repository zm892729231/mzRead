import DOMPurify from "dompurify"
import MarkdownIt from "markdown-it"

const renderer = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
})

renderer.core.ruler.push('source_map', (state) => {
  for (const token of state.tokens) {
    if (token.map && token.type !== 'inline') {
      token.attrSet('data-line', String(token.map[0]))
    }
  }
})

let headingCount = 0

const defaultLinkOpen =
  renderer.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

renderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]

  token.attrSet("target", "_blank")
  token.attrSet("rel", "noreferrer noopener")

  return defaultLinkOpen(tokens, idx, options, env, self)
}

renderer.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx]
  if (["h1", "h2", "h3", "h4"].includes(token.tag)) {
    token.attrSet("id", `heading-${headingCount++}`)
  }
  return self.renderToken(tokens, idx, options)
}

export function renderMarkdown(source: string) {
  headingCount = 0
  return DOMPurify.sanitize(renderer.render(source), {
    ADD_ATTR: ["target", "rel", "id", "data-line"], // 允许 id, data-line 属性
    FORBID_ATTR: ["style"],
    FORBID_TAGS: [
      "button",
      "embed",
      "form",
      "iframe",
      "input",
      "object",
      "option",
      "script",
      "select",
      "style",
      "textarea",
    ],
  })
}

