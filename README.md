# mzRead

mzRead 是一个面向 macOS 的本地 Markdown 阅读器，基于 Tauri 2、Vue 3 与 Rust 构建。它专注于轻量、快速、安全地打开和阅读本地 Markdown 文档，适合日常笔记、项目文档、说明书与知识库文件浏览。

## 功能特性

- 打开 `.md`、`.markdown`、`.mdown`、`.mkd` 本地 Markdown 文件
- 使用 Tailwind CSS Typography 提供舒适的阅读排版
- 自动生成文档大纲，支持标题定位与当前章节高亮
- 支持代码块快捷复制
- 使用 DOMPurify 清理 Markdown 渲染后的 HTML，降低本地阅读风险
- 支持浅色 / 深色主题切换
- 记录最近打开文件，并支持系统托盘快速访问
- 支持刷新、在访达中定位、使用外部应用打开
- 支持 macOS Markdown 文件关联

## 下载

当前首版仅发布 macOS Apple Silicon 版本：

- `mzRead_0.1.0_aarch64.dmg`：适用于 Apple Silicon Mac（M1/M2/M3/M4 等 ARM 架构）

> 说明：应用当前未做 Apple Developer ID 签名与公证。如 macOS 首次打开时提示安全限制，可在系统设置的“隐私与安全性”中允许打开。

## 技术栈

- Tauri 2
- Vue 3
- TypeScript
- Rust
- Shadcn Vue
- Tailwind CSS Typography
- markdown-it
- DOMPurify

## 开发环境

建议使用：

- Node.js 24+
- pnpm 11+
- Rust 1.88+
- macOS Apple Silicon

安装依赖：

```bash
pnpm install
```

启动开发模式：

```bash
pnpm tauri dev
```

## 构建

构建前端：

```bash
pnpm build
```

构建 macOS App 与 DMG：

```bash
pnpm tauri build
```

macOS 构建产物输出位置：

```text
src-tauri/target/release/bundle/macos/mzRead.app
src-tauri/target/release/bundle/dmg/mzRead_0.1.0_aarch64.dmg
```

## 版本

当前版本：`0.1.0`

首版重点是稳定打开、阅读和管理本地 Markdown 文档，后续可继续补充搜索、导出、更多主题、快捷键等能力。
