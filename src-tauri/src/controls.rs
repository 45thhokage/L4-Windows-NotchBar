//! Overview: system volume, brightness, Windows focus, lock and sleep.
//!
//! - Volume: default output device via `IAudioEndpointVolume` (same as the taskbar slider).
//! - Focus: Windows 11 focus session (`FocusSessionManager`, also turns on Do Not Disturb).
//!   Without that API (older builds), Do Not Disturb is set directly through the WNF state
//!   `WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED`, which is what the toggle in the
//!   notification center does.

use windows::Win32::Devices::Display::{
    DestroyPhysicalMonitors, GetNumberOfPhysicalMonitorsFromHMONITOR, GetPhysicalMonitorsFromHMONITOR, GetVCPFeatureAndVCPFeatureReply,
    MC_VCP_CODE_TYPE, SetVCPFeature, PHYSICAL_MONITOR,
};
use windows::Win32::Foundation::{HANDLE, HLOCAL, LPARAM, RECT, LocalFree};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};

use std::ffi::c_void;

use serde::Serialize;
use windows::UI::Shell::FocusSessionManager;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Power::{
    GetSystemPowerStatus, PowerGetActiveScheme, PowerReadACValueIndex, PowerReadDCValueIndex, PowerSetActiveScheme,
    PowerWriteACValueIndex, PowerWriteDCValueIndex, SetSuspendState, SYSTEM_POWER_STATUS,
};
use windows::Win32::System::Shutdown::LockWorkStation;
use windows::core::{BOOL, GUID};

#[derive(Serialize)]
pub struct Volume {
    /// 0..1
    level: f32,
    muted: bool,
}

#[derive(Serialize)]
pub struct Focus {
    active: bool,
    /// "focus" = focus session, "dnd" = only Do Not Disturb available
    kind: &'static str,
}

fn endpoint() -> windows::core::Result<IAudioEndpointVolume> {
    unsafe {
        // Own thread per call (spawn_blocking) → MTA; "already initialized" is fine.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        devices.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)
    }
}

fn read_volume() -> windows::core::Result<Volume> {
    let ep = endpoint()?;
    unsafe { Ok(Volume { level: ep.GetMasterVolumeLevelScalar()?, muted: ep.GetMute()?.as_bool() }) }
}

#[tauri::command]
pub async fn volume_get() -> Result<Volume, String> {
    tauri::async_runtime::spawn_blocking(|| read_volume().map_err(|e| e.message()))
        .await
        .map_err(|e| e.to_string())?
}

/// Sets `level` 0..1 and/or `muted`. Raising the volume unmutes, like Windows does.
#[tauri::command]
pub async fn volume_set(level: Option<f32>, muted: Option<bool>) -> Result<Volume, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ep = endpoint().map_err(|e| e.message())?;
        unsafe {
            if let Some(l) = level {
                ep.SetMasterVolumeLevelScalar(l.clamp(0.0, 1.0), std::ptr::null()).map_err(|e| e.message())?;
                if l > 0.0 && muted.is_none() {
                    let _ = ep.SetMute(false, std::ptr::null());
                }
            }
            if let Some(m) = muted {
                ep.SetMute(m, std::ptr::null()).map_err(|e| e.message())?;
            }
        }
        read_volume().map_err(|e| e.message())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Focus / Do Not Disturb ────────────────────────────────────────────────────

const WNF_QUIET_HOURS: u64 = 0x0D83_063E_A3BF_1C75;

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryWnfStateData(state: *const u64, type_id: *const c_void, scope: *const c_void, stamp: *mut u32, buffer: *mut c_void, size: *mut u32) -> i32;
    fn NtUpdateWnfStateData(state: *const u64, buffer: *const c_void, length: u32, type_id: *const c_void, scope: *const c_void, matching_stamp: u32, check_stamp: u32) -> i32;
}

/// 0 = off, 1 = priority only, 2 = alarms only.
fn dnd_profile() -> Option<u32> {
    let (mut stamp, mut value, mut size) = (0u32, 0u32, 4u32);
    let status = unsafe { NtQueryWnfStateData(&WNF_QUIET_HOURS, std::ptr::null(), std::ptr::null(), &mut stamp, (&mut value as *mut u32).cast(), &mut size) };
    (status >= 0).then_some(if size == 0 { 0 } else { value })
}

fn set_dnd(on: bool) -> Result<(), String> {
    let value: u32 = if on { 1 } else { 0 };
    let status = unsafe { NtUpdateWnfStateData(&WNF_QUIET_HOURS, (&value as *const u32).cast(), 4, std::ptr::null(), std::ptr::null(), 0, 0) };
    if status >= 0 { Ok(()) } else { Err(format!("Nicht stören ließ sich nicht schalten ({status:#x})")) }
}

fn sessions() -> Option<FocusSessionManager> {
    FocusSessionManager::IsSupported().ok().filter(|&s| s).and_then(|_| FocusSessionManager::GetDefault().ok())
}

fn read_focus() -> Focus {
    let dnd = dnd_profile().is_some_and(|p| p != 0);
    match sessions() {
        Some(m) => Focus { active: m.IsFocusActive().unwrap_or(false) || dnd, kind: "focus" },
        None => Focus { active: dnd, kind: "dnd" },
    }
}

#[tauri::command]
pub async fn focus_get() -> Focus {
    tauri::async_runtime::spawn_blocking(read_focus).await.unwrap_or(Focus { active: false, kind: "dnd" })
}

#[tauri::command]
pub async fn focus_set(active: bool) -> Result<Focus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = sessions();
        if active {
            // Prefer a focus session; if that fails, at least Do Not Disturb.
            if manager.as_ref().and_then(|m| m.TryStartFocusSession().ok()).is_none() {
                set_dnd(true)?;
            }
        } else {
            if let Some(m) = &manager {
                let _ = m.DeactivateFocus();
            }
            if dnd_profile().is_some_and(|p| p != 0) {
                set_dnd(false)?;
            }
        }
        Ok(read_focus())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Brightness ──────────────────────────────────────────────────────────────

/// `VIDEO_SUBGROUP` / `VIDEO_CURRENT_BRIGHTNESS` from powrprof.h.
const VIDEO_SUBGROUP: GUID = GUID::from_u128(0x7516B95FF77644648C5306167F40CC99);
const VIDEO_BRIGHTNESS: GUID = GUID::from_u128(0xADED5E82B90946199949F5D71DAC0BCB);

#[derive(Serialize)]
pub struct Brightness {
    /// 0..1
    level: f32,
}

/// Active power scheme GUID (freed before returning).
fn active_scheme() -> Result<GUID, String> {
    unsafe {
        let mut scheme: *mut GUID = std::ptr::null_mut();
        let rc = PowerGetActiveScheme(None, &mut scheme);
        if rc.0 != 0 || scheme.is_null() {
            return Err(format!("Energieschema nicht lesbar ({:#x})", rc.0));
        }
        let guid = *scheme;
        let _ = LocalFree(Some(HLOCAL(scheme.cast::<std::ffi::c_void>())));
        Ok(guid)
    }
}

fn on_ac() -> bool {
    unsafe {
        let mut status = std::mem::zeroed::<SYSTEM_POWER_STATUS>();
        GetSystemPowerStatus(&mut status).is_ok() && status.ACLineStatus == 1
    }
}

fn read_brightness() -> Result<Brightness, String> {
    // Desktop panels ignore the power scheme, so DDC/CI wins when present.
    if let Some(level) = ddc_levels().into_iter().next() {
        return Ok(Brightness { level });
    }
    unsafe {
        let scheme = active_scheme()?;
        let mut index = 0u32;
        // DC read returns the raw code; normalize both arms to u32.
        let code = if on_ac() {
            PowerReadACValueIndex(None, Some(&scheme), Some(&VIDEO_SUBGROUP), Some(&VIDEO_BRIGHTNESS), &mut index).0
        } else {
            PowerReadDCValueIndex(None, Some(&scheme), Some(&VIDEO_SUBGROUP), Some(&VIDEO_BRIGHTNESS), &mut index)
        };
        if code != 0 {
            return Err(format!("Helligkeit nicht lesbar ({code:#x})"));
        }
        Ok(Brightness { level: (index as f32 / 100.0).clamp(0.0, 1.0) })
    }
}

#[tauri::command]
pub async fn brightness_get() -> Result<Brightness, String> {
    tauri::async_runtime::spawn_blocking(read_brightness).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn brightness_set(level: f32) -> Result<Brightness, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let level = level.clamp(0.0, 1.0);
        // DDC/CI first: every capable external panel follows.
        let mut ddc_ok = false;
        with_physical_monitors(|h| {
            if ddc_set(h, level) {
                ddc_ok = true;
            }
        });
        if ddc_ok {
            return read_brightness();
        }
        // No DDC/CI panel: internal display via the power scheme.
        let scheme = active_scheme()?;
        let index = (level * 100.0).round() as u32;
        unsafe {
            let rc = PowerWriteACValueIndex(None, &scheme, Some(&VIDEO_SUBGROUP), Some(&VIDEO_BRIGHTNESS), index);
            if rc.0 != 0 {
                return Err(format!("Helligkeit ließ sich nicht setzen ({:#x})", rc.0));
            }
            // DC too, so the slider sticks on battery; failure there is not fatal.
            let _ = PowerWriteDCValueIndex(None, &scheme, Some(&VIDEO_SUBGROUP), Some(&VIDEO_BRIGHTNESS), index);
            let rc = PowerSetActiveScheme(None, Some(&scheme));
            if rc.0 != 0 {
                return Err(format!("Helligkeit ließ sich nicht übernehmen ({:#x})", rc.0));
            }
        }
        read_brightness()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// VCP feature code for luminance (brightness) over DDC/CI.
const VCP_BRIGHTNESS: u8 = 0x10;

unsafe extern "system" fn collect_monitor(hmon: HMONITOR, _hdc: HDC, _rect: *mut RECT, data: LPARAM) -> BOOL {
    let out = &mut *(data.0 as *mut Vec<HMONITOR>);
    out.push(hmon);
    BOOL::from(true)
}

/// Every physical monitor handle on the system (freed before returning).
fn with_physical_monitors(mut f: impl FnMut(HANDLE)) {
    let mut logical: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(collect_monitor), LPARAM(&mut logical as *mut Vec<HMONITOR> as isize));
        for hmon in logical {
            let mut count = 0u32;
            if GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, &mut count).is_err() || count == 0 {
                continue;
            }
            let mut physical = vec![PHYSICAL_MONITOR::default(); count as usize];
            if GetPhysicalMonitorsFromHMONITOR(hmon, &mut physical).is_err() {
                continue;
            }
            for pm in &physical {
                f(pm.hPhysicalMonitor);
            }
            let _ = DestroyPhysicalMonitors(&physical);
        }
    }
}

/// (current, max) VCP brightness of one physical monitor, if it supports DDC/CI.
fn ddc_read(h: HANDLE) -> Option<(u32, u32)> {
    unsafe {
        let mut kind = MC_VCP_CODE_TYPE::default();
        let (mut current, mut max) = (0u32, 0u32);
        if GetVCPFeatureAndVCPFeatureReply(h, VCP_BRIGHTNESS, Some(&mut kind), &mut current, Some(&mut max)) != 0 && max > 0 {
            Some((current.min(max), max))
        } else {
            None
        }
    }
}

fn ddc_set(h: HANDLE, level: f32) -> bool {
    unsafe {
        let mut kind = MC_VCP_CODE_TYPE::default();
        let (mut current, mut max) = (0u32, 0u32);
        if GetVCPFeatureAndVCPFeatureReply(h, VCP_BRIGHTNESS, Some(&mut kind), &mut current, Some(&mut max)) == 0 || max == 0 {
            return false;
        }
        let value = (level.clamp(0.0, 1.0) * max as f32).round() as u32;
        SetVCPFeature(h, VCP_BRIGHTNESS, value) != 0
    }
}

/// Brightness level (0..1) of every DDC/CI-capable external panel.
fn ddc_levels() -> Vec<f32> {
    let mut levels = Vec::new();
    with_physical_monitors(|h| {
        if let Some((current, max)) = ddc_read(h) {
            levels.push(current as f32 / max as f32);
        }
    });
    levels
}

#[tauri::command]
pub async fn lock_workstation() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| unsafe { LockWorkStation().map_err(|e| e.message()) })
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sleep_pc() -> Result<(), String> {
    // Returns after wake (or when an app vetoes the sleep); unsaved work vetoes,
    // like sleep from the Start menu.
    tauri::async_runtime::spawn_blocking(|| unsafe {
        if SetSuspendState(false, false, false) {
            Ok(())
        } else {
            Err("Energie sparen abgebrochen".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
