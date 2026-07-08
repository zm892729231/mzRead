import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, "..")
const appName = "mzRead.app"
const profile = process.argv.includes("--debug") ? "debug" : "release"
const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

function collectAppBundles(dir, depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return []

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const apps = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const fullPath = path.join(dir, entry.name)
    if (entry.name === appName) {
      apps.push(fullPath)
      continue
    }

    apps.push(...collectAppBundles(fullPath, depth + 1))
  }
  return apps
}

function newest(paths) {
  return paths
    .map((appPath) => ({ appPath, mtimeMs: fs.statSync(appPath).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.appPath
}

if (process.platform !== "darwin") {
  console.log("当前不是 macOS，跳过 Launch Services 注册。")
  process.exit(0)
}

const preferredApp = path.join(projectRoot, "src-tauri", "target", profile, "bundle", "macos", appName)
const fallbackApps = collectAppBundles(path.join(projectRoot, "src-tauri", "target"))
const appPath = fs.existsSync(preferredApp) ? preferredApp : newest(fallbackApps)

if (!appPath) {
  console.warn(`未找到 ${appName}，跳过 Launch Services 注册。`)
  process.exit(0)
}

console.log(`正在注册到 macOS Launch Services: ${appPath}`)
const result = spawnSync(lsregister, ["-f", appPath], { stdio: "inherit" })

if (result.error) {
  console.error("注册 mzRead.app 失败：", result.error)
  process.exit(1)
}

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

console.log("已刷新 mzRead.app 的 Launch Services 注册信息。")
console.log("提示：这会注册/刷新 App，但不会强制覆盖用户已经手动设置的默认打开方式。")
