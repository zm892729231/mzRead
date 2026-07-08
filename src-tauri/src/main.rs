// 发布版在 Windows 上不额外显示控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mzread_lib::run()
}
