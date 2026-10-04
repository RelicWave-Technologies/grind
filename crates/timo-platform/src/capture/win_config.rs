//! Maps a GDI device name to Chromium's display id, through the display-config
//! path the monitor is on (`QueryDisplayConfig`), as
//! `DisplayInfo::DisplayIdFromMonitorInfo` does (`ui/display/win/display_info.cc`,
//! Chromium 130.0.6723.118).

use windows::Win32::Devices::Display::{
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_HEADER,
    DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QDC_ONLY_ACTIVE_PATHS,
    QueryDisplayConfig,
};

use super::display_id::{windows_display_id, windows_display_id_from_device_name};

/// The `displayId` for a monitor whose NUL-terminated GDI name is `device`:
/// the hash of its path's adapter LUID and target id, or of the device name
/// when no active path names it.
pub(super) fn display_id_for_device(device: &[u16]) -> String {
    let wanted: Vec<u16> = device.iter().take_while(|c| **c != 0).copied().collect();
    match path_for_source(&wanted) {
        Some(path) => windows_display_id(
            path.targetInfo.adapterId.LowPart,
            path.targetInfo.adapterId.HighPart,
            path.targetInfo.id,
        ),
        None => windows_display_id_from_device_name(&String::from_utf16_lossy(&wanted)),
    }
}

/// `GetDisplayConfigPathInfo`: the active path whose source is named `wanted`.
fn path_for_source(wanted: &[u16]) -> Option<DISPLAYCONFIG_PATH_INFO> {
    let mut paths_len = 0u32;
    let mut modes_len = 0u32;
    // SAFETY: both counts are valid out pointers.
    let sized = unsafe {
        GetDisplayConfigBufferSizes(
            QDC_ONLY_ACTIVE_PATHS,
            &raw mut paths_len,
            &raw mut modes_len,
        )
    };
    if sized.0 != 0 {
        return None;
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); usize::try_from(paths_len).ok()?];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); usize::try_from(modes_len).ok()?];
    // SAFETY: the buffers hold exactly the counts passed, which the call updates.
    let queried = unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &raw mut paths_len,
            paths.as_mut_ptr(),
            &raw mut modes_len,
            modes.as_mut_ptr(),
            None,
        )
    };
    if queried.0 != 0 {
        return None;
    }
    let found = usize::try_from(paths_len).ok()?;
    paths
        .into_iter()
        .take(found)
        .find(|path| source_name(path).is_some_and(|name| name == wanted))
}

/// The GDI device name (`\\.\DISPLAYn`) of a path's source, without its NUL.
fn source_name(path: &DISPLAYCONFIG_PATH_INFO) -> Option<Vec<u16>> {
    let mut info = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
        header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
            r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
            size: u32::try_from(std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>()).ok()?,
            adapterId: path.sourceInfo.adapterId,
            id: path.sourceInfo.id,
        },
        ..Default::default()
    };
    // SAFETY: `info` is a sized structure starting with the header the call reads.
    let status = unsafe { DisplayConfigGetDeviceInfo(&raw mut info.header) };
    (status == 0).then(|| {
        info.viewGdiDeviceName
            .iter()
            .take_while(|c| **c != 0)
            .copied()
            .collect()
    })
}
