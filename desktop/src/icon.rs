//! Menu bar icon: a coloured status dot drawn at runtime (no image assets per state).

use tauri::image::Image;

const SIZE: u32 = 36; // 18 pt @2x

/// A filled dot in `color` with a soft halo; `None` draws a hollow grey ring (bridge unreachable).
pub fn status_dot(color: Option<[u8; 3]>) -> Image<'static> {
    let mut px = vec![0u8; (SIZE * SIZE * 4) as usize];
    let c = (SIZE as f32 - 1.0) / 2.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let (rgb, alpha) = match color {
                Some(rgb) => {
                    let core = (7.5 - d).clamp(0.0, 1.0);
                    let halo = ((12.0 - d) / 4.5).clamp(0.0, 1.0) * 0.35;
                    (rgb, core.max(halo))
                }
                None => ([150, 160, 175], (1.4 - (d - 6.5).abs()).clamp(0.0, 1.0)),
            };
            let i = ((y * SIZE + x) * 4) as usize;
            px[i..i + 3].copy_from_slice(&rgb);
            px[i + 3] = (alpha * 255.0) as u8;
        }
    }
    Image::new_owned(px, SIZE, SIZE)
}
