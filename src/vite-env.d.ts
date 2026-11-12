/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module "markdown-it-task-lists" {
  import type { PluginSimple } from "markdown-it";
  const taskLists: PluginSimple;
  export default taskLists;
}

declare module "@vscode/markdown-it-katex" {
  import type { PluginWithOptions } from "markdown-it";
  interface KatexOptions {
    throwOnError?: boolean;
    errorColor?: string;
    displayMode?: boolean;
  }
  const katexPlugin: PluginWithOptions<KatexOptions>;
  export default katexPlugin;
}
