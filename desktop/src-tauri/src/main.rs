#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod rpc;
mod terminal;

use rpc::{rpc_kill, rpc_send, rpc_spawn, RpcState};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri_plugin_window_state::StateFlags;
use terminal::{terminal_kill, terminal_resize, terminal_spawn, terminal_write, TerminalState};

const TRAY_MENU_SHOW: &str = "show";
const TRAY_MENU_QUIT: &str = "quit";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DesktopCloseBehavior {
    CloseToTray,
    CloseToQuit,
}

fn pasted_images_dir() -> PathBuf {
    std::env::temp_dir().join("jupiter-pasted-images")
}

fn parse_desktop_close_behavior(value: &serde_json::Value) -> DesktopCloseBehavior {
    match value
        .get("desktopCloseBehavior")
        .and_then(serde_json::Value::as_str)
    {
        Some("closeToTray") => DesktopCloseBehavior::CloseToTray,
        _ => DesktopCloseBehavior::CloseToQuit,
    }
}

fn config_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".jupiter").join("config.json"))
}

fn desktop_close_behavior() -> DesktopCloseBehavior {
    let Some(path) = config_path() else {
        return DesktopCloseBehavior::CloseToQuit;
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return DesktopCloseBehavior::CloseToQuit;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return DesktopCloseBehavior::CloseToQuit;
    };
    parse_desktop_close_behavior(&value)
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn persisted_window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

#[cfg(target_os = "macos")]
fn enforce_macos_native_chrome(window: &tauri::WebviewWindow) {
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(true);
    let _ = window.set_title_bar_style(tauri::TitleBarStyle::Overlay);
}

fn install_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_MENU_SHOW, "Show Window")
        .separator()
        .text(TRAY_MENU_QUIT, "Quit Jupiter")
        .build()?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Jupiter")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_MENU_SHOW => show_main_window(app),
            TRAY_MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

/// #892: bundled libwayland in AppImage can ABI-mismatch the host Wayland
/// compositor → WebKitWebProcess `abort()`s on EGL display creation. Redirect
/// the child to the host's libwayland via LD_PRELOAD before WebKit forks.
#[cfg(target_os = "linux")]
fn linux_webkit_compat() {
    fn set_default(key: &str, value: &str) {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }

    // Always-on: DMABUF renderer breaks on a wider set of Mesa stacks than
    // libwayland bundling does. Cheap to disable, slow path is still fine.
    set_default("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    let in_appimage = std::env::var_os("APPDIR").is_some();
    let on_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    if !(in_appimage && on_wayland) {
        return;
    }

    // Disable accelerated compositing as well — same EGL init path.
    set_default("WEBKIT_DISABLE_COMPOSITING_MODE", "1");

    // Skip /usr/lib/libwayland-client.so.0 — on 64-bit Fedora that path can
    // resolve to a 32-bit library and the loader prints a wrong-ELF-class
    // warning instead of preloading.
    const CANDIDATES: &[&str] = &[
        "/usr/lib64/libwayland-client.so.0",
        "/usr/lib/x86_64-linux-gnu/libwayland-client.so.0",
        "/lib/x86_64-linux-gnu/libwayland-client.so.0",
    ];
    let Some(lib) = CANDIDATES.iter().find(|p| Path::new(p).exists()) else {
        return;
    };
    let existing = std::env::var("LD_PRELOAD").unwrap_or_default();
    let merged = if existing.is_empty() {
        (*lib).to_string()
    } else {
        format!("{lib}:{existing}")
    };
    std::env::set_var("LD_PRELOAD", merged);
}

#[derive(Serialize)]
struct FileEntry {
    path: String,
    depth: u32,
    kind: &'static str,
    name: String,
}

const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "out"];
const MAX_ENTRIES: usize = 800;

fn walk_dir(dir: &Path, depth: u32, max_depth: u32, out: &mut Vec<FileEntry>) {
    if depth > max_depth || out.len() >= MAX_ENTRIES {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| {
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        (!is_dir, e.file_name())
    });
    for entry in items {
        if out.len() >= MAX_ENTRIES {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // Hidden files (.git, .next, .env) and well-known noise dirs.
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path().to_string_lossy().into_owned();
        if file_type.is_dir() {
            out.push(FileEntry {
                path: path.clone(),
                depth,
                kind: "dir",
                name,
            });
            walk_dir(&entry.path(), depth + 1, max_depth, out);
        } else if file_type.is_file() {
            out.push(FileEntry {
                path,
                depth,
                kind: "file",
                name,
            });
        }
    }
}

#[tauri::command]
fn list_workspace_tree(root: String, max_depth: u32) -> Result<Vec<FileEntry>, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let mut out = Vec::new();
    walk_dir(root_path, 0, max_depth.min(4), &mut out);
    Ok(out)
}

#[derive(Serialize)]
struct GitStatusEntry {
    path: String,
    kind: &'static str,
}

#[derive(Serialize)]
struct TerminalCommandResult {
    code: i32,
    stdout: String,
    stderr: String,
}

#[tauri::command]
fn git_status(root: String) -> Result<Vec<GitStatusEntry>, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    git_status_entries(root_path)
}

fn git_status_entries(root_path: &Path) -> Result<Vec<GitStatusEntry>, String> {
    use std::process::Command;
    let mut cmd = Command::new("git");
    cmd.arg("status")
        .arg("--porcelain")
        .arg("-z")
        .current_dir(root_path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return Ok(Vec::new()), // not a git repo / no git on PATH — silent
    };
    if !output.status.success() {
        return Ok(Vec::new()); // not a git repo — silent
    }
    let mut out = Vec::new();
    for rec in output.stdout.split(|&b| b == 0) {
        if rec.len() < 4 {
            continue;
        }
        // `git status --porcelain -z` format: `XY ` + path, where X / Y are
        // index / worktree statuses. Map both to a coarse `kind`.
        let x = rec[0];
        let y = rec[1];
        let kind = match (x, y) {
            (b'?', b'?') => "untracked",
            (b'A', _) | (_, b'A') => "added",
            (b'D', _) | (_, b'D') => "deleted",
            (b'M', _) | (_, b'M') => "modified",
            (b'R', _) | (_, b'R') => "renamed",
            _ => continue,
        };
        let path = String::from_utf8_lossy(&rec[3..]).into_owned();
        out.push(GitStatusEntry { path, kind });
    }
    Ok(out)
}

#[tauri::command]
fn git_diff(root: String) -> Result<String, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let status = git_status_entries(root_path)?;
    let staged = git_diff_output(root_path, true)?;
    let unstaged = git_diff_output(root_path, false)?;
    let untracked = status
        .iter()
        .filter(|entry| entry.kind == "untracked")
        .filter_map(|entry| git_untracked_diff_output(root_path, &entry.path).ok())
        .filter(|chunk| !chunk.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok([staged, unstaged, untracked]
        .into_iter()
        .filter(|chunk| !chunk.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n"))
}

fn git_diff_output(root_path: &Path, cached: bool) -> Result<String, String> {
    use std::process::Command;
    let mut cmd = Command::new("git");
    cmd.arg("-c")
        .arg("core.quotepath=false")
        .arg("diff")
        .arg("--no-ext-diff");
    if cached {
        cmd.arg("--cached");
    }
    cmd.arg("--").current_dir(root_path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return Ok(String::new()),
    };
    if !output.status.success() {
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn git_untracked_diff_output(root_path: &Path, path: &str) -> Result<String, String> {
    use std::process::Command;
    let null_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut cmd = Command::new("git");
    cmd.arg("-c")
        .arg("core.quotepath=false")
        .arg("diff")
        .arg("--no-ext-diff")
        .arg("--no-index")
        .arg("--")
        .arg(null_path)
        .arg(path)
        .current_dir(root_path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return Ok(String::new()),
    };
    // `git diff --no-index` exits with 1 when differences are present.
    if !output.status.success() && output.status.code() != Some(1) {
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
fn run_terminal_command(root: String, command: String) -> Result<TerminalCommandResult, String> {
    use std::process::{Command, Stdio};
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("command is empty".into());
    }

    #[cfg(windows)]
    let mut cmd = {
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd".into());
        let mut cmd = Command::new(shell);
        cmd.arg("/C").arg(trimmed);
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };

    #[cfg(not(windows))]
    let mut cmd = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut cmd = Command::new(shell);
        cmd.arg("-lc").arg(trimmed);
        cmd
    };

    let output = cmd
        .current_dir(root_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("run command: {e}"))?;

    Ok(TerminalCommandResult {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[tauri::command]
fn open_in_editor(command: String, path: String, line: Option<u32>) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("editor command is empty".into());
    }
    // VS Code / Cursor / Windsurf understand `-g path:line`; harmless for others if `line` is None.
    let mut cmd;
    #[cfg(windows)]
    {
        // Spawn through cmd.exe so `.cmd` shims (code.cmd, cursor.cmd) resolve via PATH.
        // Normalize forward slashes to backslashes — cmd.exe doesn't handle them reliably.
        let normalized = path.replace('/', "\\");
        cmd = Command::new("cmd");
        cmd.arg("/c").arg(trimmed);
        if let Some(l) = line {
            cmd.arg("-g").arg(format!("{}:{}", normalized, l));
        } else {
            cmd.arg(&normalized);
        }
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        cmd = Command::new(trimmed);
        if let Some(l) = line {
            cmd.arg("-g").arg(format!("{}:{}", path, l));
        } else {
            cmd.arg(&path);
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn().map_err(|e| format!("spawn {trimmed}: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FilePreview {
    path: String,
    abs_path: String,
    name: String,
    ext: Option<String>,
    kind: String,
    bytes: u64,
    modified_ms: Option<u128>,
    text: Option<String>,
    truncated: bool,
}

fn resolve_preview_path(path: &str, workspace_dir: Option<&str>) -> Result<PathBuf, String> {
    let raw = PathBuf::from(path);
    if raw.is_absolute() {
        return raw
            .canonicalize()
            .map_err(|e| format!("resolve failed: {e}"));
    }
    let Some(root) = workspace_dir.filter(|v| !v.trim().is_empty()) else {
        return raw
            .canonicalize()
            .map_err(|e| format!("resolve failed: {e}"));
    };
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("workspace resolve failed: {e}"))?;
    let candidate = root.join(path);
    let abs = candidate
        .canonicalize()
        .map_err(|e| format!("resolve failed: {e}"))?;
    if !abs.starts_with(&root) {
        return Err("path is outside the workspace".into());
    }
    Ok(abs)
}

fn preview_kind(ext: Option<&str>) -> &'static str {
    let Some(ext) = ext else {
        return "binary";
    };
    match ext {
        "bmp" | "gif" | "jpeg" | "jpg" | "png" | "svg" | "webp" => "image",
        "doc" | "docx" | "pdf" | "ppt" | "pptx" | "xls" | "xlsx" => "document",
        "bash" | "c" | "cc" | "cljs" | "clj" | "cpp" | "cs" | "css" | "csv" | "cts" | "cxx"
        | "dart" | "dockerfile" | "erl" | "ex" | "exs" | "fish" | "go" | "graphql" | "h"
        | "hpp" | "hs" | "htm" | "html" | "hxx" | "java" | "js" | "json" | "jsonc" | "jsx"
        | "kt" | "less" | "lua" | "md" | "mdx" | "mjs" | "mts" | "php" | "proto" | "py" | "pyi"
        | "rb" | "rs" | "scss" | "sh" | "sql" | "svelte" | "swift" | "toml" | "ts" | "tsx"
        | "txt" | "vue" | "xml" | "yaml" | "yml" | "zig" | "zsh" => "text",
        _ => "binary",
    }
}

fn push_limited(out: &mut String, value: &str, limit: usize) -> bool {
    if out.len() >= limit {
        return true;
    }
    let remaining = limit - out.len();
    if value.len() <= remaining {
        out.push_str(value);
        return false;
    }
    let mut end = 0;
    for (idx, ch) in value.char_indices() {
        let next = idx + ch.len_utf8();
        if next > remaining {
            break;
        }
        end = next;
    }
    if end > 0 {
        out.push_str(&value[..end]);
    }
    true
}

fn decode_xml_entities(value: &str) -> String {
    if !value.contains('&') {
        return value.to_string();
    }
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let entity_start = start + 1;
        let Some(end_rel) = rest[entity_start..].find(';') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let entity_end = entity_start + end_rel;
        let entity = &rest[entity_start..entity_end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if entity.starts_with("#x") => u32::from_str_radix(&entity[2..], 16)
                .ok()
                .and_then(char::from_u32),
            _ if entity.starts_with('#') => {
                entity[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        if let Some(ch) = decoded {
            out.push(ch);
        } else {
            out.push('&');
            out.push_str(entity);
            out.push(';');
        }
        rest = &rest[(entity_end + 1)..];
    }
    out.push_str(rest);
    out
}

fn push_docx_text_segment(out: &mut String, text: &str, limit: usize) -> bool {
    if text.is_empty() {
        return false;
    }
    push_limited(out, &decode_xml_entities(text), limit)
}

fn docx_xml_to_text(xml: &str, limit: usize) -> (String, bool) {
    let mut out = String::new();
    let mut text = String::new();
    let mut tag = String::new();
    let mut in_tag = false;
    let mut capture_text = false;
    let mut truncated = false;

    for ch in xml.chars() {
        if in_tag {
            if ch == '>' {
                in_tag = false;
                let raw_tag = tag.trim();
                let is_closing = raw_tag.starts_with('/');
                let is_self_closing = raw_tag.ends_with('/');
                let name = raw_tag
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .trim_end_matches('/');
                if name == "w:t" || name == "w:instrText" {
                    capture_text = !is_closing && !is_self_closing;
                } else if name == "w:tab" {
                    truncated = push_limited(&mut out, "\t", limit);
                } else if name == "w:br" || raw_tag.starts_with("/w:p") {
                    if !out.ends_with('\n') {
                        truncated = push_limited(&mut out, "\n", limit);
                    }
                }
                tag.clear();
                if truncated {
                    break;
                }
            } else {
                tag.push(ch);
            }
            continue;
        }
        if ch == '<' {
            truncated = push_docx_text_segment(&mut out, &text, limit);
            text.clear();
            in_tag = true;
            if truncated {
                break;
            }
        } else if capture_text {
            text.push(ch);
        }
    }
    if !truncated {
        truncated = push_docx_text_segment(&mut out, &text, limit);
    }
    (out.trim().to_string(), truncated)
}

fn read_docx_preview(path: &Path, limit: usize) -> Result<(String, bool), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open failed: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("docx archive failed: {e}"))?;
    let mut document = archive
        .by_name("word/document.xml")
        .map_err(|e| format!("docx document missing: {e}"))?;
    let mut xml = String::new();
    use std::io::Read;
    document
        .read_to_string(&mut xml)
        .map_err(|e| format!("docx read failed: {e}"))?;
    Ok(docx_xml_to_text(&xml, limit))
}

#[tauri::command]
fn read_file_preview(path: String, workspace_dir: Option<String>) -> Result<FilePreview, String> {
    use std::io::Read;
    const MAX_TEXT_BYTES: usize = 256 * 1024;
    let abs = resolve_preview_path(&path, workspace_dir.as_deref())?;
    let metadata = std::fs::metadata(&abs).map_err(|e| format!("metadata failed: {e}"))?;
    if !metadata.is_file() {
        return Err("not a file".into());
    }
    let ext = abs
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    let name = abs
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path.as_str())
        .to_string();
    let kind = preview_kind(ext.as_deref()).to_string();
    let mut text = None;
    let mut truncated = false;
    if kind == "text" {
        let mut file = std::fs::File::open(&abs).map_err(|e| format!("open failed: {e}"))?;
        let mut bytes = Vec::new();
        file.by_ref()
            .take((MAX_TEXT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("read failed: {e}"))?;
        if bytes.len() > MAX_TEXT_BYTES {
            bytes.truncate(MAX_TEXT_BYTES);
            truncated = true;
        }
        text = Some(String::from_utf8_lossy(&bytes).into_owned());
    } else if ext.as_deref() == Some("docx") {
        if let Ok((docx_text, docx_truncated)) = read_docx_preview(&abs, MAX_TEXT_BYTES) {
            if !docx_text.is_empty() {
                text = Some(docx_text);
                truncated = docx_truncated;
            }
        }
    }
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis());
    Ok(FilePreview {
        path,
        abs_path: abs.to_string_lossy().into_owned(),
        name,
        ext,
        kind,
        bytes: metadata.len(),
        modified_ms,
        text,
        truncated,
    })
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("write failed: {e}"))
}

fn sanitize_image_extension(raw: Option<&str>) -> String {
    let cleaned = raw
        .map(|s| s.trim().trim_start_matches('.').to_ascii_lowercase())
        .unwrap_or_default();
    let ok = !cleaned.is_empty()
        && cleaned.len() <= 8
        && cleaned.chars().all(|c| c.is_ascii_alphanumeric());
    if ok {
        cleaned
    } else {
        "png".to_string()
    }
}

#[tauri::command]
fn save_clipboard_image(bytes: Vec<u8>, extension: Option<String>) -> Result<String, String> {
    let ext = sanitize_image_extension(extension.as_deref());
    let dir = pasted_images_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("clock error: {e}"))?
        .as_millis();
    let path = dir.join(format!("jupiter-pasted-{ts}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| format!("write failed: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn purge_old_pasted_images(max_age: Duration) {
    let dir = pasted_images_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let cutoff = SystemTime::now().checked_sub(max_age);
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if cutoff.is_some_and(|t| modified < t) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    linux_webkit_compat();

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(persisted_window_state_flags())
                .build(),
        )
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if desktop_close_behavior() == DesktopCloseBehavior::CloseToTray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .manage(RpcState::default())
        .manage(TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            rpc_spawn,
            rpc_send,
            rpc_kill,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill,
            open_in_editor,
            list_workspace_tree,
            git_status,
            git_diff,
            run_terminal_command,
            read_file_preview,
            write_text_file,
            save_clipboard_image
        ])
        .setup(|app| {
            std::thread::spawn(|| purge_old_pasted_images(Duration::from_secs(24 * 60 * 60)));
            install_tray(app)?;
            if let Some(w) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                enforce_macos_native_chrome(&w);

                // HiDPI fit: the JSON config asks for 1024x720 logical px.
                // On Windows laptops at 200% scale (1920x1080 → 960x540
                // effective logical px) that overflows the screen and the
                // window opens partially off-canvas. Clamp to 90% of the
                // monitor's available logical size whenever the configured
                // size doesn't fit, then recenter.
                if let Ok(Some(monitor)) = w.current_monitor() {
                    let scale = monitor.scale_factor();
                    let phys = monitor.size();
                    let avail_w = phys.width as f64 / scale;
                    let avail_h = phys.height as f64 / scale;
                    let want_w = 1024_f64.min(avail_w * 0.9);
                    let want_h = 720_f64.min(avail_h * 0.9);
                    if want_w < 1024.0 || want_h < 720.0 {
                        let _ = w.set_size(tauri::Size::Logical(tauri::LogicalSize {
                            width: want_w,
                            height: want_h,
                        }));
                        let _ = w.center();
                    }
                }
                if std::env::var("JUPITER_DEVTOOLS").is_ok() {
                    #[cfg(debug_assertions)]
                    w.open_devtools();
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri build failed")
        .run(|app, event| match event {
            // Tauri 2 normally exits the process via Exit; managed-state drops
            // don't always run. ExitRequested fires before that, so we kill the
            // Node child here too — belt-and-braces vs the Drop on RpcHandle.
            tauri::RunEvent::ExitRequested { .. } => {
                let state = app.state::<RpcState>();
                let _ = rpc::rpc_kill(state);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => show_main_window(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{
        docx_xml_to_text, parse_desktop_close_behavior, persisted_window_state_flags,
        sanitize_image_extension, DesktopCloseBehavior,
    };
    use serde_json::json;
    use tauri_plugin_window_state::StateFlags;

    #[test]
    fn accepts_alphanumeric_extensions() {
        assert_eq!(sanitize_image_extension(Some("png")), "png");
        assert_eq!(sanitize_image_extension(Some("JPG")), "jpg");
        assert_eq!(sanitize_image_extension(Some(".webp")), "webp");
        assert_eq!(sanitize_image_extension(Some("svg")), "svg");
    }

    #[test]
    fn falls_back_when_missing_or_invalid() {
        assert_eq!(sanitize_image_extension(None), "png");
        assert_eq!(sanitize_image_extension(Some("")), "png");
        assert_eq!(sanitize_image_extension(Some("   ")), "png");
    }

    #[test]
    fn rejects_path_separators_and_traversal() {
        assert_eq!(sanitize_image_extension(Some("png/../../foo")), "png");
        assert_eq!(sanitize_image_extension(Some("png\\foo")), "png");
        assert_eq!(sanitize_image_extension(Some("../bin")), "png");
        assert_eq!(sanitize_image_extension(Some("p.n.g")), "png");
    }

    #[test]
    fn rejects_overlong_extensions() {
        assert_eq!(sanitize_image_extension(Some("verylongext")), "png");
    }

    #[test]
    fn docx_xml_to_text_extracts_paragraph_text() {
        let xml = r#"<w:document><w:body><w:p><w:r><w:t>Hello &amp; hi</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Jupiter</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r></w:p></w:body></w:document>"#;

        let (text, truncated) = docx_xml_to_text(xml, 1024);

        assert_eq!(text, "Hello & hi\tJupiter\nNext");
        assert!(!truncated);
    }

    #[test]
    fn docx_xml_to_text_truncates_on_utf8_boundary() {
        let xml = r#"<w:document><w:body><w:p><w:r><w:t>你好 Jupiter</w:t></w:r></w:p></w:body></w:document>"#;

        let (text, truncated) = docx_xml_to_text(xml, 5);

        assert_eq!(text, "你");
        assert!(truncated);
    }

    #[test]
    fn desktop_close_behavior_defaults_to_quit() {
        assert_eq!(
            parse_desktop_close_behavior(&json!({})),
            DesktopCloseBehavior::CloseToQuit
        );
    }

    #[test]
    fn desktop_close_behavior_accepts_tray_mode() {
        assert_eq!(
            parse_desktop_close_behavior(&json!({ "desktopCloseBehavior": "closeToTray" })),
            DesktopCloseBehavior::CloseToTray
        );
    }

    #[test]
    fn desktop_close_behavior_accepts_quit_mode() {
        assert_eq!(
            parse_desktop_close_behavior(&json!({ "desktopCloseBehavior": "closeToQuit" })),
            DesktopCloseBehavior::CloseToQuit
        );
    }

    #[test]
    fn window_state_does_not_restore_decorations() {
        assert!(!persisted_window_state_flags().contains(StateFlags::DECORATIONS));
        assert!(!persisted_window_state_flags().contains(StateFlags::FULLSCREEN));
        assert!(!persisted_window_state_flags().contains(StateFlags::VISIBLE));
    }
}
