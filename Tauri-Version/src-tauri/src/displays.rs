//! Monitor list in the same order ffmpeg's `ddagrab=output_idx=N` uses
//! (outputs of the default DXGI adapter).

use serde::Serialize;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub display_id: String,
    pub name: String,
    pub primary: bool,
    #[serde(skip)]
    pub rect: (i32, i32, i32, i32), // x, y, width, height in physical pixels
}

pub fn list() -> Vec<Display> {
    let mut out = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return out };
        let Ok(adapter) = factory.EnumAdapters1(0) else { return out };
        let mut i = 0;
        while let Ok(output) = adapter.EnumOutputs(i) {
            if let Ok(desc) = output.GetDesc() {
                let r = desc.DesktopCoordinates;
                let (w, h) = (r.right - r.left, r.bottom - r.top);
                let primary = r.left == 0 && r.top == 0;
                out.push(Display {
                    display_id: i.to_string(),
                    name: format!("Skjerm {} — {}×{}{}", i + 1, w, h, if primary { " (hovedskjerm)" } else { "" }),
                    primary,
                    rect: (r.left, r.top, w, h),
                });
            }
            i += 1;
        }
    }
    out
}

/// The display to record: the configured one if it still exists, else the primary.
pub fn resolve(id: Option<&str>) -> Option<Display> {
    let all = list();
    id.and_then(|id| all.iter().find(|d| d.display_id == id).cloned())
        .or_else(|| all.iter().find(|d| d.primary).cloned())
        .or_else(|| all.first().cloned())
}
