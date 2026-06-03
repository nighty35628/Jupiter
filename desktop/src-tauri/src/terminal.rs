use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct TerminalState {
    inner: Arc<Mutex<HashMap<String, TerminalHandle>>>,
    next_token: AtomicU64,
}

struct TerminalHandle {
    token: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>,
}

#[derive(Clone, Serialize)]
struct TerminalOutputEvent {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalExitEvent {
    id: String,
    code: Option<i32>,
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(4, 200),
        cols: cols.clamp(20, 400),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn shell_command(root: &Path) -> CommandBuilder {
    #[cfg(windows)]
    let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd".into());
    #[cfg(not(windows))]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.cwd(root);
    cmd
}

fn stop_handle(mut handle: TerminalHandle) {
    let _ = handle.writer.flush();
    drop(handle.writer);
    if let Some(mut child) = handle.child.lock().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<'_, TerminalState>,
    id: String,
    root: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    if let Some(existing) = state.inner.lock().remove(&id) {
        stop_handle(existing);
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(pty_size(cols, rows))
        .map_err(|e| format!("open pty: {e}"))?;
    let child = pair
        .slave
        .spawn_command(shell_command(root_path))
        .map_err(|e| format!("spawn shell: {e}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take pty writer: {e}"))?;
    let child = Arc::new(Mutex::new(Some(child)));
    let token = state.next_token.fetch_add(1, Ordering::Relaxed);

    state.inner.lock().insert(
        id.clone(),
        TerminalHandle {
            token,
            master: pair.master,
            writer,
            child: child.clone(),
        },
    );

    let app_for_output = app.clone();
    let id_for_output = id.clone();
    let inner_for_exit = state.inner.clone();
    thread::spawn(move || {
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_for_output.emit(
                        "terminal:output",
                        TerminalOutputEvent {
                            id: id_for_output.clone(),
                            data,
                        },
                    );
                }
                Err(e) => {
                    let _ = app_for_output.emit(
                        "terminal:output",
                        TerminalOutputEvent {
                            id: id_for_output.clone(),
                            data: format!("\r\nterminal read error: {e}\r\n"),
                        },
                    );
                    break;
                }
            }
        }

        let code = child
            .lock()
            .take()
            .and_then(|mut child| child.wait().ok())
            .map(|status| status.exit_code() as i32);
        let mut inner = inner_for_exit.lock();
        if inner
            .get(&id_for_output)
            .map(|handle| handle.token == token)
            .unwrap_or(false)
        {
            inner.remove(&id_for_output);
        }
        drop(inner);
        let _ = app_for_output.emit(
            "terminal:exit",
            TerminalExitEvent {
                id: id_for_output,
                code,
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut guard = state.inner.lock();
    let handle = guard.get_mut(&id).ok_or("terminal not found")?;
    handle
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("terminal write: {e}"))?;
    handle
        .writer
        .flush()
        .map_err(|e| format!("terminal flush: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = state.inner.lock();
    let handle = guard.get(&id).ok_or("terminal not found")?;
    handle
        .master
        .resize(pty_size(cols, rows))
        .map_err(|e| format!("terminal resize: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn terminal_kill(state: State<'_, TerminalState>, id: String) -> Result<(), String> {
    if let Some(handle) = state.inner.lock().remove(&id) {
        stop_handle(handle);
    }
    Ok(())
}
