import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const args = process.argv.slice(2)
const command = args.find((arg) => !arg.startsWith("-"))
const tauriBin = process.platform === "win32" ? "tauri.cmd" : "tauri"

const tauriResult = spawnSync(tauriBin, args, {
  stdio: "inherit",
  env: process.env,
})

function registerMacApp() {
  const registerArgs = []
  if (args.includes("--debug")) registerArgs.push("--debug")

  const registerScript = path.join(__dirname, "register-macos-app.mjs")
  return spawnSync(process.execPath, [registerScript, ...registerArgs], {
    stdio: "inherit",
    env: process.env,
  })
}

if (tauriResult.error) {
  console.error("执行 Tauri CLI 失败：", tauriResult.error)
  process.exit(1)
}

if (tauriResult.status !== 0) {
  if (process.platform === "darwin" && command === "build") {
    console.warn("Tauri build 未完全成功，但仍尝试注册已经生成的 mzRead.app。")
    registerMacApp()
  }
  process.exit(tauriResult.status ?? 1)
}

if (process.platform === "darwin" && command === "build") {
  const registerResult = registerMacApp()

  if (registerResult.error) {
    console.error("执行 macOS App 注册脚本失败：", registerResult.error)
    process.exit(1)
  }

  process.exit(registerResult.status ?? 0)
}

process.exit(0)
