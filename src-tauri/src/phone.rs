//! Send to phone: shelf files over the local network with no app or account.
//!
//! Starting shares the shelf through a tiny one-thread HTTP server on a random
//! port: the phone scans a QR code (or opens the shown URL) and gets a plain
//! file list with download links. Random token in every link, only while the
//! panel is open, hard stop after 10 minutes. One connection at a time and
//! only indexed files are served, so there is no directory to wander out of.
//! Windows Firewall asks once on first use: that prompt is the OS doing its job.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::State;
use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};

/// Share lifetime: the code dies on its own even if the panel is forgotten.
const SHARE_TTL: Duration = Duration::from_secs(600);
/// Accept polling step; also sets how fast a stop lands.
const ACCEPT_STEP: Duration = Duration::from_millis(200);

#[derive(Default)]
pub struct PhoneState {
    running: Mutex<Option<Running>>,
}

struct Running {
    shutdown: std::sync::Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneShare {
    url: String,
    /// QR code of the URL as a PNG data URL.
    qr: String,
    files: usize,
}

#[tauri::command]
pub fn phone_start(paths: Vec<String>, state: State<'_, PhoneState>) -> Result<PhoneShare, String> {
    // All quick local work (bind, token, QR): no blocking runtime needed.
    start(paths, &state)
}

#[tauri::command]
pub fn phone_stop(state: State<'_, PhoneState>) {
    stop(&state);
}

fn start(paths: Vec<String>, state: &PhoneState) -> Result<PhoneShare, String> {
    stop(state);
    let files: Vec<std::path::PathBuf> = paths.into_iter().map(std::path::PathBuf::from).filter(|p| p.is_file()).collect();
    if files.is_empty() {
        return Err("Keine Dateien zum Senden".to_string());
    }
    let token = random_token()?;
    let listener = TcpListener::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let url = format!("http://{}:{port}/?key={token}", lan_ip());
    let qr = qr_data_url(&url)?;
    let shutdown = std::sync::Arc::new(AtomicBool::new(false));
    let worker = shutdown.clone();
    let deadline = Instant::now() + SHARE_TTL;
    let count = files.len();
    let thread = thread::spawn(move || serve(listener, worker, deadline, token, files));
    *state.running.lock().unwrap() = Some(Running { shutdown, thread: Some(thread) });
    Ok(PhoneShare { url, qr, files: count })
}

fn stop(state: &PhoneState) {
    let thread = state.running.lock().unwrap().take().and_then(|mut r| {
        r.shutdown.store(true, Ordering::Relaxed);
        r.thread.take()
    });
    if let Some(t) = thread {
        let _ = t.join();
    }
}

fn serve(listener: TcpListener, shutdown: std::sync::Arc<AtomicBool>, deadline: Instant, token: String, files: Vec<std::path::PathBuf>) {
    while !shutdown.load(Ordering::Relaxed) && Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                handle_one(&mut stream, &token, &files);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(ACCEPT_STEP),
            Err(_) => break,
        }
    }
}

fn handle_one(stream: &mut std::net::TcpStream, token: &str, files: &[std::path::PathBuf]) {
    let mut buf = [0u8; 4096];
    let Ok(n) = stream.read(&mut buf) else { return };
    let head = String::from_utf8_lossy(&buf[..n]);
    let line = head.lines().next().unwrap_or("");
    let mut parts = line.split_whitespace();
    if parts.next() != Some("GET") {
        return write_raw(stream, "405 Method Not Allowed", "text/plain", b"no");
    }
    let target = parts.next().unwrap_or("/");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if !query.split('&').any(|kv| kv == format!("key={token}")) {
        return write_raw(stream, "403 Forbidden", "text/plain", b"no");
    }
    if path == "/" || path == "/index.html" {
        let mut html = String::from("<!doctype html><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>NotchBar</title><ul>");
        for (i, f) in files.iter().enumerate() {
            let name = esc(&f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "?".into()));
            html.push_str(&format!("<li><a href=\"/f/{i}?key={token}\">{name}</a></li>"));
        }
        html.push_str("</ul>");
        return write_raw(stream, "200 OK", "text/html; charset=utf-8", html.as_bytes());
    }
    if let Some(rest) = path.strip_prefix("/f/") {
        if let Ok(i) = rest.parse::<usize>() {
            if let Some(f) = files.get(i) {
                if let Ok(bytes) = std::fs::read(f) {
                    let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nContent-Disposition: attachment; filename=\"{}\"\r\nConnection: close\r\n\r\n",
                        mime_for(f),
                        bytes.len(),
                        esc(&name).replace('"', ""),
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&bytes);
                    return;
                }
            }
        }
    }
    write_raw(stream, "404 Not Found", "text/plain", b"no");
}

fn write_raw(stream: &mut std::net::TcpStream, status: &str, ctype: &str, body: &[u8]) {
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(body);
}

fn mime_for(path: &std::path::Path) -> &'static str {
    match path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// This machine's LAN address: a UDP "connection" sends nothing, it only asks
/// the OS which interface would route out.
fn lan_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    unsafe {
        if BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG).is_ok() {
            Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
        } else {
            Err("Schlüssel ließ sich nicht erzeugen".to_string())
        }
    }
}

fn qr_data_url(url: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(url).map_err(|e| e.to_string())?;
    let img = code.render::<image::Luma<u8>>().max_dimensions(320, 320).build();
    let mut png = Vec::new();
    image::DynamicImage::ImageLuma8(img)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
}
