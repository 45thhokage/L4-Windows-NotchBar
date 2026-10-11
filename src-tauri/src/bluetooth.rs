//! Paired Bluetooth devices, on demand (no background thread).
//!
//! Classic Win32 `bthprops` enumeration: remembered + authenticated devices,
//! no inquiry scan, so a call is a fast registry read. The overview panel calls
//! `bluetooth_list` when opened (and every few seconds while open); connecting
//! re-lists once it settles.

use std::collections::HashMap;

use serde::Serialize;
use windows::Win32::Devices::Bluetooth::{
    BLUETOOTH_DEVICE_INFO, BLUETOOTH_DEVICE_SEARCH_PARAMS, BLUETOOTH_FIND_RADIO_PARAMS,
    BLUETOOTH_SERVICE_ENABLE, BluetoothFindDeviceClose, BluetoothFindFirstDevice,
    BluetoothFindFirstRadio, BluetoothFindNextDevice, BluetoothFindNextRadio,
    BluetoothFindRadioClose, BluetoothSetServiceState,
};
use windows::Devices::Bluetooth::{BluetoothCacheMode, BluetoothConnectionStatus, BluetoothLEDevice};
use windows::Devices::Bluetooth::GenericAttributeProfile::GattCommunicationStatus;
use windows::Storage::Streams::DataReader;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{GUID, PCWSTR, w};

/// A2DP sink: enabling it on a paired headset/phone connects the audio stream.
const AUDIO_SINK: GUID = GUID::from_u128(0x0000110B00001000800000805F9B34FB);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BtDevice {
    name: String,
    /// 48-bit address; exact through JSON (well below 2^53).
    address: u64,
    connected: bool,
    /// Raw class-of-device; the frontend maps it to an icon.
    class: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BtState {
    /// False when the machine has no Bluetooth radio at all.
    radio: bool,
    devices: Vec<BtDevice>,
}

fn radios() -> Vec<HANDLE> {
    let mut out = Vec::new();
    unsafe {
        let params = BLUETOOTH_FIND_RADIO_PARAMS {
            dwSize: std::mem::size_of::<BLUETOOTH_FIND_RADIO_PARAMS>() as u32,
        };
        let mut radio = HANDLE::default();
        let Ok(find) = BluetoothFindFirstRadio(&params, &mut radio) else {
            return out;
        };
        if !radio.is_invalid() {
            out.push(radio);
        }
        loop {
            radio = HANDLE::default();
            if BluetoothFindNextRadio(find, &mut radio).is_err() || radio.is_invalid() {
                break;
            }
            out.push(radio);
        }
        let _ = BluetoothFindRadioClose(find);
    }
    out
}

fn close_radios(radios: &[HANDLE]) {
    unsafe {
        for &radio in radios {
            let _ = CloseHandle(radio);
        }
    }
}

fn name_of(info: &BLUETOOTH_DEVICE_INFO) -> String {
    let end = info.szName.iter().position(|&c| c == 0).unwrap_or(info.szName.len());
    String::from_utf16_lossy(&info.szName[..end])
}

fn address_of(info: &BLUETOOTH_DEVICE_INFO) -> u64 {
    unsafe { info.Address.Anonymous.ullLong }
}

/// Remembered + authenticated devices on one radio. No inquiry scan, so this
/// is a fast registry read.
fn devices_on(radio: HANDLE) -> Vec<BLUETOOTH_DEVICE_INFO> {
    let mut out = Vec::new();
    unsafe {
        let params = BLUETOOTH_DEVICE_SEARCH_PARAMS {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
            fReturnAuthenticated: true.into(),
            fReturnRemembered: true.into(),
            fReturnUnknown: false.into(),
            fReturnConnected: true.into(),
            fIssueInquiry: false.into(),
            cTimeoutMultiplier: 1,
            hRadio: radio,
        };
        let mut info = BLUETOOTH_DEVICE_INFO {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
            ..Default::default()
        };
        let Ok(find) = BluetoothFindFirstDevice(&params, &mut info) else {
            return out;
        };
        loop {
            out.push(info);
            info = BLUETOOTH_DEVICE_INFO {
                dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
                ..Default::default()
            };
            if BluetoothFindNextDevice(find, &mut info).is_err() {
                break;
            }
        }
        let _ = BluetoothFindDeviceClose(find);
    }
    out
}

/// Fresh list across all radios; connected devices first, then by name.
fn snapshot() -> BtState {
    let found = radios();
    let mut seen: HashMap<u64, BtDevice> = HashMap::new();
    for radio in &found {
        for info in devices_on(*radio) {
            let dev = BtDevice {
                name: name_of(&info),
                address: address_of(&info),
                connected: info.fConnected.as_bool(),
                class: info.ulClassofDevice,
            };
            seen.entry(dev.address)
                .and_modify(|old| {
                    if dev.connected {
                        *old = dev.clone();
                    }
                })
                .or_insert(dev);
        }
    }
    close_radios(&found);
    let mut devices: Vec<BtDevice> = seen.into_values().collect();
    devices.sort_by(|a, b| {
        b.connected
            .cmp(&a.connected)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    BtState { radio: !found.is_empty(), devices }
}

#[tauri::command]
pub async fn bluetooth_list() -> Result<BtState, String> {
    tauri::async_runtime::spawn_blocking(snapshot).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn bluetooth_connect(address: u64) -> Result<BtState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let found = radios();
        let mut target: Option<(HANDLE, BLUETOOTH_DEVICE_INFO)> = None;
        for radio in &found {
            for info in devices_on(*radio) {
                if address_of(&info) == address {
                    target = Some((*radio, info));
                    break;
                }
            }
            if target.is_some() {
                break;
            }
        }
        let Some((radio, info)) = target else {
            close_radios(&found);
            return Err("Gerät nicht mehr gekoppelt".to_string());
        };
        let rc = unsafe { BluetoothSetServiceState(Some(radio), &info, &AUDIO_SINK, BLUETOOTH_SERVICE_ENABLE) };
        close_radios(&found);
        if rc != 0 {
            return Err(format!("Verbinden fehlgeschlagen ({rc:#x})"));
        }
        // Connecting takes a moment; re-read once it settles.
        std::thread::sleep(std::time::Duration::from_secs(2));
        Ok(snapshot())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn bluetooth_settings() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let r = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                w!("ms-settings:bluetooth"),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if (r.0 as usize) > 32 {
            Ok(())
        } else {
            Err("Bluetooth-Einstellungen ließen sich nicht öffnen".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Battery service + Battery Level characteristic UUIDs (plain consts can't fail).
const BATTERY_SERVICE: GUID = GUID::from_u128(0x0000180F00001000800000805F9B34FB);
const BATTERY_LEVEL: GUID = GUID::from_u128(0x00002A1900001000800000805F9B34FB);

/// Battery level (0–100) of a connected device via the GATT Battery Service.
/// Best effort: anything unknown maps to `None`, never an error popup.
fn battery_level(address: u64) -> Option<u8> {
    let device = BluetoothLEDevice::FromBluetoothAddressAsync(address).ok()?.join().ok()?;
    if device.ConnectionStatus().ok()? != BluetoothConnectionStatus::Connected {
        return None;
    }
    let services = device
        .GetGattServicesForUuidWithCacheModeAsync(BATTERY_SERVICE, BluetoothCacheMode::Uncached)
        .ok()?
        .join()
        .ok()?
        .Services()
        .ok()?;
    for service in services {
        let chars = service
            .GetCharacteristicsWithCacheModeAsync(BluetoothCacheMode::Uncached)
            .ok()?
            .join()
            .ok()?
            .Characteristics()
            .ok()?;
        for c in chars {
            if c.Uuid().ok()? != BATTERY_LEVEL {
                continue;
            }
            let read = c.ReadValueWithCacheModeAsync(BluetoothCacheMode::Uncached).ok()?.join().ok()?;
            if read.Status().ok()? != GattCommunicationStatus::Success {
                continue;
            }
            let reader = DataReader::FromBuffer(&read.Value().ok()?).ok()?;
            if reader.UnconsumedBufferLength().ok()? < 1 {
                return None;
            }
            return reader.ReadByte().ok();
        }
    }
    None
}

#[tauri::command]
pub async fn bluetooth_battery(address: u64) -> Result<Option<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || battery_level(address)).await.map_err(|e| e.to_string())
}
