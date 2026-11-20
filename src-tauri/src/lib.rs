use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, Runtime, Url, WebviewWindowBuilder};

const MAX_MARKDOWN_BYTES: u64 = 10 * 1024 * 1024;
const MAX_TRAY_RECENT_PATHS: usize = 8;
const RECENT_PATHS_FILE: &str = "recent-files.json";
const SETTINGS_FILE: &str = "settings.json";

#[derive(Serialize)]
struct MarkdownDocument {
    path: String,
    file_name: String,
    content: String,
    size_bytes: u64,
    modified_ms: Option<u128>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default)]
struct AppSettings {
    show_tray_icon: bool,
}

struct OpenedFiles(Mutex<Vec<String>>);
struct RecentPathsState(Mutex<Vec<String>>);
struct AppSettingsState(Mutex<AppSettings>);
struct FileWatcherState(Mutex<Option<RecommendedWatcher>>);

fn settings_file<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(SETTINGS_FILE))
        .map_err(|err| format!("无法定位应用配置目录：{err}"))
}

fn load_settings_from_disk<R: Runtime>(app: &tauri::AppHandle<R>) -> AppSettings {
    let Ok(path) = settings_file(app) else {
        return AppSettings::default();
    };

    let Ok(content) = fs::read_to_string(path) else {
        return AppSettings::default();
    };

    serde_json::from_str::<AppSettings>(&content).unwrap_or_default()
}

fn save_settings_to_disk<R: Runtime>(
    app: &tauri::AppHandle<R>,
    settings: &AppSettings,
) -> Result<(), String> {
    let path = settings_file(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("无法创建应用配置目录：{err}"))?;
    }

    let content = serde_json::to_string_pretty(settings)
        .map_err(|err| format!("无法序列化应用配置：{err}"))?;
    fs::write(path, content).map_err(|err| format!("无法保存应用配置：{err}"))
}

fn is_tray_visible<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.state::<AppSettingsState>()
        .0
        .lock()
        .unwrap()
        .show_tray_icon
}

fn sync_tray_visibility<R: Runtime>(
    app: &tauri::AppHandle<R>,
    visible: bool,
) -> Result<(), String> {
    if visible {
        let paths = app.state::<RecentPathsState>().0.lock().unwrap().clone();
        let menu = build_tray_menu(app, &paths)
            .map_err(|err| format!("无法构建顶部菜单栏菜单：{err}"))?;

        if let Some(tray) = app.tray_by_id("main") {
            tray.set_menu(Some(menu))
                .map_err(|err| format!("无法更新顶部菜单栏菜单：{err}"))?;
            tray.set_visible(true)
                .map_err(|err| format!("无法显示顶部菜单栏图标：{err}"))?;
        } else {
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| "缺少默认窗口图标".to_string())?;
            TrayIconBuilder::with_id("main")
                .icon(icon)
                .menu(&menu)
                .build(app)
                .map_err(|err| format!("无法创建顶部菜单栏图标：{err}"))?;
        }
    } else if let Some(tray) = app.tray_by_id("main") {
        tray.set_visible(false)
            .map_err(|err| format!("无法隐藏顶部菜单栏图标：{err}"))?;
    }

    Ok(())
}

fn recent_paths_file<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(RECENT_PATHS_FILE))
        .map_err(|err| format!("无法定位应用配置目录：{err}"))
}

fn normalize_recent_paths(paths: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for path in paths {
        let path = path.trim();
        if path.is_empty() || normalized.iter().any(|item| item == path) {
            continue;
        }
        normalized.push(path.to_string());
    }
    normalized
}

fn load_recent_paths_from_disk<R: Runtime>(app: &tauri::AppHandle<R>) -> Vec<String> {
    let Ok(path) = recent_paths_file(app) else {
        return Vec::new();
    };

    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };

    serde_json::from_str::<Vec<String>>(&content)
        .map(normalize_recent_paths)
        .unwrap_or_default()
}

fn save_recent_paths_to_disk<R: Runtime>(
    app: &tauri::AppHandle<R>,
    paths: &[String],
) -> Result<(), String> {
    let path = recent_paths_file(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("无法创建最近文件记录目录：{err}"))?;
    }

    let content = serde_json::to_string_pretty(paths)
        .map_err(|err| format!("无法序列化最近文件记录：{err}"))?;
    fs::write(path, content).map_err(|err| format!("无法保存最近文件记录：{err}"))
}

fn sync_recent_paths<R: Runtime>(
    app: &tauri::AppHandle<R>,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let paths = normalize_recent_paths(paths);
    {
        let state = app.state::<RecentPathsState>();
        let mut lock = state.0.lock().unwrap();
        *lock = paths.clone();
    }

    save_recent_paths_to_disk(app, &paths)?;

    // 实时同步更新系统托盘菜单
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(menu) = build_tray_menu(app, &paths) {
            let _ = tray.set_menu(Some(menu));
        }
    }

    Ok(paths)
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "mdown" | "mkd"
            )
        })
        .unwrap_or(false)
}

fn markdown_paths_from_args(args: Vec<String>, cwd: &str) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter_map(|arg| {
            let path = if let Ok(url) = Url::parse(&arg) {
                if url.scheme() != "file" {
                    return None;
                }
                url.to_file_path().ok()?
            } else {
                let path = PathBuf::from(&arg);
                if path.is_absolute() || cwd.is_empty() {
                    path
                } else {
                    PathBuf::from(cwd).join(path)
                }
            };

            if is_markdown_path(&path) {
                Some(path.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect()
}

fn initial_markdown_paths() -> Vec<String> {
    let cwd = std::env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();

    markdown_paths_from_args(std::env::args().collect(), &cwd)
}

fn show_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let Some(window_config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
    else {
        eprintln!("缺少 main 窗口配置，无法打开 mzRead 主窗口");
        return;
    };

    match WebviewWindowBuilder::from_config(app, window_config).and_then(|builder| builder.build())
    {
        Ok(window) => {
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(err) => {
            eprintln!("打开 mzRead 主窗口失败：{err}");
        }
    }
}

fn emit_open_files<R: Runtime>(app: &tauri::AppHandle<R>, paths: Vec<String>) {
    let paths = normalize_recent_paths(paths);
    if paths.is_empty() {
        return;
    }

    let mut recent_paths = paths.clone();
    recent_paths.extend(load_recent_paths_from_disk(app));
    let _ = sync_recent_paths(app, recent_paths);

    {
        let state = app.state::<OpenedFiles>();
        let mut opened_files = state.0.lock().unwrap();
        *opened_files = paths.clone();
    }
    let _ = app.emit("opened-files", paths);
    show_main_window(app);
}

fn read_document(path: PathBuf) -> Result<MarkdownDocument, String> {
    let path = path
        .canonicalize()
        .map_err(|err| format!("无法解析文件真实路径：{err}"))?;

    if !is_markdown_path(&path) {
        return Err("请选择 .md、.markdown、.mdown 或 .mkd 文件".to_string());
    }

    let metadata = fs::metadata(&path).map_err(|err| format!("无法读取文件信息：{err}"))?;
    if !metadata.is_file() {
        return Err("请选择一个 Markdown 文件，而不是文件夹".to_string());
    }
    if metadata.len() > MAX_MARKDOWN_BYTES {
        return Err("文件超过 10MB，首版阅读器暂不直接打开超大 Markdown".to_string());
    }

    let content =
        fs::read_to_string(&path).map_err(|err| format!("无法按 UTF-8 读取文件：{err}"))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("未命名文档")
        .to_string();

    Ok(MarkdownDocument {
        path: path.to_string_lossy().to_string(),
        file_name,
        content,
        size_bytes: metadata.len(),
        modified_ms,
    })
}

fn build_tray_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    paths: &[String],
) -> Result<Menu<R>, tauri::Error> {
    let menu = Menu::new(app)?;

    // 1. 打开主窗口
    let open_window_item = MenuItem::with_id(app, "open_window", "打开新窗口", true, None::<&str>)?;
    menu.append(&open_window_item)?;
    let top_sep = PredefinedMenuItem::separator(app)?;
    menu.append(&top_sep)?;

    // 2. 最近文档标题 (置灰菜单项)
    let header_item = MenuItem::with_id(app, "recent_header", "最近打开文档", false, None::<&str>)?;
    menu.append(&header_item)?;

    // 3. 最近文档列表
    if paths.is_empty() {
        let empty_item = MenuItem::with_id(app, "no_recent", "暂无历史记录", false, None::<&str>)?;
        menu.append(&empty_item)?;
    } else {
        for path in paths.iter().take(MAX_TRAY_RECENT_PATHS) {
            let p = PathBuf::from(path);
            let raw_name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("未命名文档");
            
            let mut file_name = raw_name.to_string();
            let max_chars = 30;
            if file_name.chars().count() > max_chars {
                file_name = file_name.chars().take(max_chars).collect::<String>();
                file_name.push_str("...");
            }

            let item = MenuItem::with_id(app, path, &file_name, true, None::<&str>)?;
            menu.append(&item)?;
        }
    }

    // 4. 第一条分割线
    let sep1 = PredefinedMenuItem::separator(app)?;
    menu.append(&sep1)?;

    // 5. 版本与作者署名 (置灰)
    let version_label = format!("Version {}", env!("CARGO_PKG_VERSION"));
    let version_item =
        MenuItem::with_id(app, "tray_version", version_label, false, None::<&str>)?;
    let author_item = MenuItem::with_id(
        app,
        "tray_author",
        "Crafted with ❤️ by mz",
        false,
        None::<&str>,
    )?;
    menu.append(&version_item)?;
    menu.append(&author_item)?;

    // 6. 第二条分割线
    let sep2 = PredefinedMenuItem::separator(app)?;
    menu.append(&sep2)?;

    // 7. 退出软件
    let exit_item = MenuItem::with_id(app, "exit_app", "退出软件", true, Some("CmdOrCtrl+Q"))?;
    menu.append(&exit_item)?;

    Ok(menu)
}

#[tauri::command]
fn read_markdown_file(path: String) -> Result<MarkdownDocument, String> {
    read_document(PathBuf::from(path))
}

#[tauri::command]
fn write_markdown_file(path: String, content: String) -> Result<MarkdownDocument, String> {
    let path_buf = PathBuf::from(&path);
    if !is_markdown_path(&path_buf) {
        return Err("请选择 .md、.markdown、.mdown 或 .mkd 文件".to_string());
    }

    fs::write(&path_buf, &content).map_err(|err| format!("无法写入文件：{err}"))?;

    let metadata = fs::metadata(&path_buf).map_err(|err| format!("无法读取文件信息：{err}"))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());
    let file_name = path_buf
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("未命名文档")
        .to_string();

    Ok(MarkdownDocument {
        path,
        file_name,
        content,
        size_bytes: metadata.len(),
        modified_ms,
    })
}

#[tauri::command]
fn get_files_metadata(paths: Vec<String>) -> HashMap<String, u128> {
    let mut map = HashMap::new();
    for path_str in paths {
        let path = PathBuf::from(&path_str);
        if let Ok(metadata) = fs::metadata(&path) {
            if let Ok(modified) = metadata.modified() {
                if let Ok(duration) = modified.duration_since(UNIX_EPOCH) {
                    map.insert(path_str, duration.as_millis());
                }
            }
        }
    }
    map
}

#[tauri::command]
fn opened_files(app: tauri::AppHandle) -> Vec<String> {
    let state = app.state::<OpenedFiles>();
    let mut files = state.0.lock().unwrap();
    files.drain(..).collect()
}

#[tauri::command]
fn recent_paths(app: tauri::AppHandle) -> Vec<String> {
    let paths = load_recent_paths_from_disk(&app);
    {
        let state = app.state::<RecentPathsState>();
        let mut lock = state.0.lock().unwrap();
        *lock = paths.clone();
    }

    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(menu) = build_tray_menu(&app, &paths) {
            let _ = tray.set_menu(Some(menu));
        }
    }

    paths
}

#[tauri::command]
fn watch_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target_path = PathBuf::from(&path);
    if !target_path.exists() {
        return Err("文件不存在".to_string());
    }

    let state = app.state::<FileWatcherState>();
    let mut lock = state.0.lock().unwrap();
    // 释放旧的文件监听器
    *lock = None;

    let app_handle = app.clone();
    let canonical_target = target_path
        .canonicalize()
        .unwrap_or_else(|_| target_path.clone());
    let canonical_str = canonical_target.to_string_lossy().to_string();

    let watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if matches!(event.kind, EventKind::Modify(_)) {
                    for p in &event.paths {
                        let is_match = p
                            .canonicalize()
                            .map(|cp| cp == canonical_target)
                            .unwrap_or_else(|_| p == &canonical_target);
                        if is_match {
                            let _ = app_handle.emit("file-modified", canonical_str.clone());
                            break;
                        }
                    }
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("创建文件监听器失败：{e}"))?;

    let mut watcher = watcher;
    let watch_dir = target_path.parent().unwrap_or(&target_path);
    watcher
        .watch(watch_dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("注册文件系统监听失败：{e}"))?;

    *lock = Some(watcher);
    Ok(())
}

#[tauri::command]
fn unwatch_file(app: tauri::AppHandle) {
    let state = app.state::<FileWatcherState>();
    let mut lock = state.0.lock().unwrap();
    *lock = None;
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn update_recent_paths(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    sync_recent_paths(&app, paths).map(|_| ())
}

#[tauri::command]
fn get_tray_visible(app: tauri::AppHandle) -> bool {
    is_tray_visible(&app)
}

#[tauri::command]
fn set_tray_visible(app: tauri::AppHandle, visible: bool) -> Result<bool, String> {
    sync_tray_visibility(&app, visible)?;

    let updated = {
        let state = app.state::<AppSettingsState>();
        let mut lock = state.0.lock().unwrap();
        lock.show_tray_icon = visible;
        lock.clone()
    };

    save_settings_to_disk(&app, &updated)?;
    Ok(visible)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .manage(OpenedFiles(Mutex::new(Vec::new())))
        .manage(RecentPathsState(Mutex::new(Vec::new())))
        .manage(AppSettingsState(Mutex::new(AppSettings::default())))
        .manage(FileWatcherState(Mutex::new(None)));

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // 第二个实例只负责把文件路径转发给第一个实例，避免重复创建窗口。
            let paths = markdown_paths_from_args(args, &cwd);
            emit_open_files(app, paths);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_markdown_file,
            write_markdown_file,
            get_files_metadata,
            opened_files,
            recent_paths,
            exit_app,
            update_recent_paths,
            get_tray_visible,
            set_tray_visible,
            watch_file,
            unwatch_file
        ])
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "open_window" => show_main_window(app),
                "exit_app" => {
                    // 通知前端保存未保存内容并安全退出
                    let _ = app.emit("request-exit", ());
                }
                "no_recent" | "recent_header" | "tray_version" | "tray_author" => {}
                _ => {
                    // 通知前端加载文件
                    let _ = app.emit("open-file", id.to_string());
                    // 聚焦并显式窗口
                    show_main_window(app);
                }
            }
        })
        .setup(|app| {
            let settings = load_settings_from_disk(app.handle());
            {
                let state = app.state::<AppSettingsState>();
                let mut lock = state.0.lock().unwrap();
                *lock = settings.clone();
            }

            let recent_paths = load_recent_paths_from_disk(app.handle());
            {
                let state = app.state::<RecentPathsState>();
                let mut lock = state.0.lock().unwrap();
                *lock = recent_paths;
            }

            // 按配置决定启动时是否显示系统顶部菜单栏图标（默认隐藏）
            if settings.show_tray_icon {
                sync_tray_visibility(app.handle(), true).map_err(std::io::Error::other)?;
            }

            // Windows 通过文件关联首次启动时只会传入命令行参数，不会触发 Opened 事件。
            emit_open_files(app.handle(), initial_markdown_paths());

            // 未显示顶部菜单栏图标时直接打开主窗口，避免无入口可用
            if !settings.show_tray_icon && app.get_webview_window("main").is_none() {
                show_main_window(app.handle());
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用构建失败")
        .run(|app, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" => {
                #[cfg(not(target_os = "macos"))]
                if !is_tray_visible(app) {
                    api.prevent_close();
                    let _ = app.emit("request-exit", ());
                    return;
                }

                api.prevent_close();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                if !has_visible_windows {
                    show_main_window(app);
                }
            }
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            tauri::RunEvent::Opened { urls } => {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter(|path| is_markdown_path(path))
                    .map(|path| path.to_string_lossy().to_string())
                    .collect::<Vec<_>>();

                emit_open_files(app, paths);
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::AppSettings;

    #[test]
    fn app_settings_defaults_to_hidden_tray_icon() {
        let defaults = AppSettings::default();
        assert!(!defaults.show_tray_icon);

        let from_empty: AppSettings = serde_json::from_str("{}").unwrap();
        assert!(!from_empty.show_tray_icon);

        let enabled: AppSettings = serde_json::from_str(r#"{"show_tray_icon": true}"#).unwrap();
        assert!(enabled.show_tray_icon);
    }
}
