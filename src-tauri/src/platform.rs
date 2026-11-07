use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinuxIntegrationStatus {
    pub available: bool,
    pub session: String,
    pub installed: bool,
    pub message: String,
}

pub fn is_hyprland_session() -> bool {
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
        return true;
    }
    std::env::var("XDG_CURRENT_DESKTOP")
        .map(|d| d.to_ascii_lowercase().contains("hyprland"))
        .unwrap_or(false)
}

pub fn linux_integration_status() -> LinuxIntegrationStatus {
    if !cfg!(target_os = "linux") {
        return LinuxIntegrationStatus {
            available: false,
            session: "other".into(),
            installed: false,
            message: "Linux integration is only available on Linux".into(),
        };
    }

    let session = if is_hyprland_session() {
        "hyprland"
    } else if std::env::var("XDG_SESSION_TYPE").unwrap_or_default() == "x11" {
        "x11"
    } else {
        "other"
    };

    LinuxIntegrationStatus {
        available: session == "hyprland",
        session: session.into(),
        installed: false,
        message: if session == "hyprland" {
            "Hyprland detected. Use wl-copy/wtype for paste.".into()
        } else {
            "No managed Hyprland integration required for this session.".into()
        },
    }
}

pub fn install_linux_integration() -> LinuxIntegrationStatus {
    linux_integration_status()
}

pub fn remove_linux_integration() -> LinuxIntegrationStatus {
    linux_integration_status()
}
