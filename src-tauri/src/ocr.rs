//! On-demand text recognition for clipboard images (no background work).
//!
//! Legacy `Windows.Media.Ocr` reads dark text on light best, at a good size.
//! Screenshots are often the opposite (light on dark, small UI type), so the
//! caller can opt into cheap preprocessing before the engine runs:
//! 2x upscale for small captures, grayscale plus contrast stretch, and auto
//! invert of dark backgrounds. All of it stays offline on the device.
//!
//! Research consensus for this engine family: grayscale via luminosity, stretch
//! contrast to the full range (no hard binarization for thin UI fonts), a
//! target line height well above 20 px, the right language model, and reading
//! order rebuilt from word boxes instead of trusting engine line order.

use serde::Deserialize;
use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat, BitmapTransform, ColorManagementMode,
    ExifOrientationMode, SoftwareBitmap,
};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, IRandomAccessStream, InMemoryRandomAccessStream};
use windows::core::Interface;

/// Fixed OCR pipeline options. Defaults encode the ablation winner: English
/// model with upscale, enhance, invert and sort on, binarize off.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct OcrOptions {
    #[serde(default)]
    pub lang: Option<String>,
    #[serde(default)]
    pub upscale: Option<bool>,
    #[serde(default)]
    pub enhance: Option<bool>,
    #[serde(default)]
    pub invert: Option<bool>,
    #[serde(default)]
    pub sort: Option<bool>,
    #[serde(default)]
    pub binarize: Option<bool>,
}

impl OcrOptions {
    fn upscale(&self) -> bool {
        self.upscale.unwrap_or(true)
    }
    fn enhance(&self) -> bool {
        self.enhance.unwrap_or(true)
    }
    fn invert(&self) -> bool {
        self.invert.unwrap_or(true)
    }
    fn sort(&self) -> bool {
        self.sort.unwrap_or(true)
    }
    fn binarize(&self) -> bool {
        self.binarize.unwrap_or(false)
    }
    fn lang(&self) -> &str {
        self.lang.as_deref().unwrap_or("en")
    }
}

pub fn ocr_png_with(png: &[u8], opts: &OcrOptions) -> Result<String, String> {
    let engine = create_engine(opts.lang())?;
    let bytes = preprocess(png, opts);
    let src: &[u8] = if bytes.is_empty() { png } else { &bytes };
    recognize(&engine, src, opts.sort())
}

fn create_engine(lang: &str) -> Result<OcrEngine, String> {
    match lang {
        "en" | "de" => {
            let tag = if lang == "en" { "en" } else { "de" };
            let htag = windows::core::HSTRING::from(tag);
            let language = windows::Globalization::Language::CreateLanguage(&htag).map_err(|e| e.message())?;
            if OcrEngine::IsLanguageSupported(&language).unwrap_or(false) {
                OcrEngine::TryCreateFromLanguage(&language).map_err(|_| {
                    format!("OCR-Sprachpaket fehlt für {tag}")
                })
            } else {
                // Pack not installed: fall back to the profile engine instead of
                // failing outright; accuracy may drop for this call.
                OcrEngine::TryCreateFromUserProfileLanguages()
                    .map_err(|_| format!("OCR-Sprachpaket fehlt für {tag}"))
            }
        }
        _ => OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|_| "Texterkennung nicht verfügbar (OCR-Sprachpaket fehlt)".to_string()),
    }
}

/// Best-effort preprocess with the `image` crate. Never fails the OCR call:
/// any error falls back to the original bytes.
fn preprocess(png: &[u8], opts: &OcrOptions) -> Vec<u8> {
    let loaded = image::load_from_memory(png).ok();
    let Some(mut dynimg) = loaded else { return Vec::new() };
    // Strip alpha early: translucent pixels confuse the luminance stats.
    let mut rgba = dynimg.to_rgba8();
    for p in rgba.pixels_mut() {
        p[3] = 255;
    }
    dynimg = image::DynamicImage::ImageRgba8(rgba);

    if opts.upscale() {
        let (w, h) = (dynimg.width(), dynimg.height());
        if w.max(h) < 2000 && w > 0 && h > 0 {
            let scale = 2.0;
            let (mut nw, mut nh) = ((w as f32 * scale) as u32, (h as f32 * scale) as u32);
            // Cap work: a 2x upscale of a near-2000 px shot is plenty.
            if nw.max(nh) > 3000 {
                let k = 3000.0 / nw.max(nh) as f32;
                nw = ((nw as f32 * k) as u32).max(1);
                nh = ((nh as f32 * k) as u32).max(1);
            }
            dynimg = dynimg.resize(nw, nh, image::imageops::FilterType::Triangle);
        }
    }

    if opts.enhance() {
        // Luminosity grayscale, then stretch to the full range. No hard
        // threshold here: binarization shatters thin colored UI fonts, so it
        // stays behind its own option below.
        let mut gray = dynimg.to_luma8();
        let mut min = 255u8;
        let mut max = 0u8;
        for p in gray.pixels() {
            let v = p[0];
            if v < min {
                min = v;
            }
            if v > max {
                max = v;
            }
        }
        if max > min + 12 {
            let span = (max - min) as f32;
            for p in gray.pixels_mut() {
                let v = p[0] as f32;
                p[0] = (((v - min as f32) / span) * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
        // Mild sharpen: crispens thin strokes after the upscale. Gentle kernel
        // so clean captures do not grow halos.
        gray = image::imageops::filter3x3(&gray, &[0.0, -0.25, 0.0, -0.25, 2.0, -0.25, 0.0, -0.25, 0.0]);
        if opts.binarize() {
            otsu(&mut gray);
        }
        if opts.invert() && mean_gray(&gray) < 110.0 {
            image::imageops::invert(&mut gray);
        }
        dynimg = image::DynamicImage::ImageLuma8(gray);
    } else if opts.invert() {
        // Color path: still detect light-on-dark via luma mean, then invert.
        let gray = dynimg.to_luma8();
        if mean_gray(&gray) < 110.0 {
            let mut rgba = dynimg.to_rgba8();
            for p in rgba.pixels_mut() {
                p[0] = 255 - p[0];
                p[1] = 255 - p[1];
                p[2] = 255 - p[2];
            }
            dynimg = image::DynamicImage::ImageRgba8(rgba);
        }
    }

    // White edge padding: the engine clips glyphs at image borders, and both
    // failing captures run text edge to edge. Fixed 12 px, always on.
    dynimg = pad_white(&dynimg, 12);

    let mut out = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut out);
        if dynimg.write_to(&mut cursor, image::ImageFormat::Png).is_err() {
            return Vec::new();
        }
    }
    out
}

fn mean_gray(gray: &image::GrayImage) -> f32 {
    let (sum, n) = gray.pixels().fold((0u64, 0u64), |(s, n), p| (s + p[0] as u64, n + 1));
    if n == 0 {
        255.0
    } else {
        sum as f32 / n as f32
    }
}

/// Otsu hard threshold to pure black and white. Only behind the binarize
/// option: great for clean documents, destructive for colored UI type.
fn otsu(gray: &mut image::GrayImage) {
    let mut hist = [0u64; 256];
    for p in gray.pixels() {
        hist[p[0] as usize] += 1;
    }
    let total: u64 = hist.iter().sum();
    if total == 0 {
        return;
    }
    let sum_all: f64 = hist.iter().enumerate().map(|(i, &n)| i as f64 * n as f64).sum();
    let (mut sum_bg, mut weight_bg, mut best_var, mut threshold) = (0.0, 0u64, -1.0, 127u8);
    for (t, &n) in hist.iter().enumerate() {
        weight_bg += n;
        if weight_bg == 0 || weight_bg == total {
            continue;
        }
        sum_bg += t as f64 * n as f64;
        let weight_fg = total - weight_bg;
        let mean_bg = sum_bg / weight_bg as f64;
        let mean_fg = (sum_all - sum_bg) / weight_fg as f64;
        let var = weight_bg as f64 * weight_fg as f64 * (mean_bg - mean_fg).powi(2);
        if var > best_var {
            best_var = var;
            threshold = t as u8;
        }
    }
    for p in gray.pixels_mut() {
        p[0] = if p[0] > threshold { 255 } else { 0 };
    }
}

fn pad_white(img: &image::DynamicImage, border: u32) -> image::DynamicImage {
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    let mut canvas =
        image::RgbaImage::from_pixel(w + border * 2, h + border * 2, image::Rgba([255, 255, 255, 255]));
    image::imageops::overlay(&mut canvas, &rgba, border as i64, border as i64);
    image::DynamicImage::ImageRgba8(canvas)
}

/// Conservative cleanup for predictable engine tics: stray spaces before
/// punctuation, runs of spaces, and bullet marks glued to words. Never
/// touches newlines, decimals, or interior hyphens.
fn tidy(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // Collapse space runs (not newlines).
        if c == ' ' && out.ends_with(' ') {
            i += 1;
            continue;
        }
        // Space before punctuation: drop it unless it guards a decimal.
        // A closing bracket or quote before the mark counts as word-like.
        if c == ' '
            && i + 1 < chars.len()
            && ".,;:!?%)".contains(chars[i + 1])
            && out.chars().last().is_some_and(|p| p.is_alphanumeric() || ['(', ')', ']', '}', '"', '\''].contains(&p))
        {
            let prev_is_digit = out.chars().last().is_some_and(|p| p.is_ascii_digit());
            let next_is_digit = i + 2 < chars.len() && chars[i + 2].is_ascii_digit();
            let is_decimal = prev_is_digit && next_is_digit && (chars[i + 1] == '.' || chars[i + 1] == ',');
            if !is_decimal {
                i += 1;
                continue;
            }
        }
        // Bullet glued to a word is a misread quote, never a real list marker.
        if c == '•'
            && (out.chars().last().is_some_and(|p| !p.is_whitespace())
                || (i + 1 < chars.len() && !chars[i + 1].is_whitespace()))
        {
            out.push('"');
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

fn recognize(engine: &OcrEngine, png: &[u8], sort: bool) -> Result<String, String> {
    let max = OcrEngine::MaxImageDimension().map_err(|e| e.message())?;
    let stream = InMemoryRandomAccessStream::new().map_err(|e| e.message())?;
    let out = stream.GetOutputStreamAt(0).map_err(|e| e.message())?;
    let writer = DataWriter::CreateDataWriter(&out).map_err(|e| e.message())?;
    writer.WriteBytes(png).map_err(|e| e.message())?;
    writer.StoreAsync().map_err(|e| e.message())?.join().map_err(|e| e.message())?;
    writer.FlushAsync().map_err(|e| e.message())?.join().map_err(|e| e.message())?;
    let _ = writer.DetachStream();
    let ras: IRandomAccessStream = stream.cast().map_err(|e| e.message())?;
    let decoder = BitmapDecoder::CreateAsync(&ras).map_err(|e| e.message())?.join().map_err(|e| e.message())?;
    let (w, h) = (decoder.PixelWidth().map_err(|e| e.message())?, decoder.PixelHeight().map_err(|e| e.message())?);
    let bmp = if w.max(h) > max {
        let scale = max as f64 / w.max(h) as f64;
        let t = BitmapTransform::new().map_err(|e| e.message())?;
        t.SetScaledWidth(((w as f64 * scale) as u32).max(1)).map_err(|e| e.message())?;
        t.SetScaledHeight(((h as f64 * scale) as u32).max(1)).map_err(|e| e.message())?;
        t.SetInterpolationMode(BitmapInterpolationMode::Linear).map_err(|e| e.message())?;
        decoder
            .GetSoftwareBitmapTransformedAsync(
                BitmapPixelFormat::Bgra8,
                BitmapAlphaMode::Premultiplied,
                &t,
                ExifOrientationMode::RespectExifOrientation,
                ColorManagementMode::DoNotColorManage,
            )
            .map_err(|e| e.message())?
            .join()
            .map_err(|e| e.message())?
    } else {
        let bmp = decoder.GetSoftwareBitmapAsync().map_err(|e| e.message())?.join().map_err(|e| e.message())?;
        SoftwareBitmap::ConvertWithAlpha(&bmp, BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied)
            .map_err(|e| e.message())?
    };
    let result = engine.RecognizeAsync(&bmp).map_err(|e| e.message())?.join().map_err(|e| e.message())?;
    let mut lines: Vec<(f32, f32, String)> = Vec::new();
    for line in result.Lines().map_err(|e| e.message())? {
        let text = line.Text().map_err(|e| e.message())?.to_string();
        if text.trim().is_empty() {
            continue;
        }
        let (mut y, mut x) = (f32::MAX, f32::MAX);
        if let Ok(words) = line.Words() {
            let mut first = true;
            for w in words {
                if let Ok(r) = w.BoundingRect() {
                    if first || r.Y < y || (r.Y == y && r.X < x) {
                        y = r.Y;
                        x = r.X;
                    }
                    first = false;
                }
            }
        }
        lines.push((y, x, text.trim_end().to_string()));
    }
    if sort {
        // Engine order jumbles multi-size text: rebuild top to bottom,
        // left to right. Lines without boxes keep engine order at the end.
        lines.sort_by(|a, b| {
            let ay = if a.0 == f32::MAX { f32::MAX } else { (a.0 / 24.0).floor() };
            let by = if b.0 == f32::MAX { f32::MAX } else { (b.0 / 24.0).floor() };
            ay.partial_cmp(&by).unwrap_or(std::cmp::Ordering::Equal).then(
                a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal),
            )
        });
    }
    let mut text = String::new();
    for (_, _, t) in lines {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&t);
    }
    if text.trim().is_empty() {
        return Err("Kein Text erkannt".to_string());
    }
    Ok(tidy(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts_all() -> OcrOptions {
        OcrOptions {
            lang: Some("auto".into()),
            upscale: Some(false),
            enhance: Some(true),
            invert: Some(true),
            sort: Some(true),
            binarize: Some(false),
        }
    }

    fn encode_png(img: &image::DynamicImage) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut cursor = std::io::Cursor::new(&mut out);
            img.write_to(&mut cursor, image::ImageFormat::Png).unwrap();
        }
        out
    }

    fn mean_of(png: &[u8]) -> f32 {
        mean_gray(&image::load_from_memory(png).unwrap().to_luma8())
    }

    /// Light text on dark (both failing captures): output must flip to dark on light.
    #[test]
    fn preprocess_inverts_dark_background() {
        let mut img = image::RgbaImage::from_pixel(64, 64, image::Rgba([18, 20, 28, 255]));
        for y in 20..44 {
            for x in 8..56 {
                img.put_pixel(x, y, image::Rgba([235, 235, 235, 255]));
            }
        }
        let out = preprocess(&encode_png(&image::DynamicImage::ImageRgba8(img)), &opts_all());
        assert!(!out.is_empty());
        assert!(mean_of(&out) > 150.0, "dark capture was not inverted");
    }

    /// Dark text on light must stay dark on light.
    #[test]
    fn preprocess_keeps_light_background() {
        let mut img = image::RgbaImage::from_pixel(64, 64, image::Rgba([245, 245, 245, 255]));
        for y in 20..44 {
            for x in 8..56 {
                img.put_pixel(x, y, image::Rgba([20, 20, 20, 255]));
            }
        }
        let out = preprocess(&encode_png(&image::DynamicImage::ImageRgba8(img)), &opts_all());
        assert!(!out.is_empty());
        assert!(mean_of(&out) > 150.0, "light capture changed unexpectedly");
    }

    /// Padding adds a fixed white border around the capture.
    #[test]
    fn preprocess_pads_white_border() {
        let img = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            64,
            48,
            image::Rgba([200, 200, 200, 255]),
        ));
        let out = preprocess(&encode_png(&img), &opts_all());
        let decoded = image::load_from_memory(&out).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (64 + 24, 48 + 24));
        assert_eq!(decoded.to_rgba8().get_pixel(0, 0).0, [255, 255, 255, 255]);
    }

    /// Binarize leaves only pure black and white behind.
    #[test]
    fn preprocess_binarize_is_two_tone() {
        let mut img = image::RgbaImage::from_pixel(64, 64, image::Rgba([240, 240, 240, 255]));
        for y in 20..44 {
            for x in 8..56 {
                img.put_pixel(x, y, image::Rgba([30, 30, 30, 255]));
            }
        }
        let opts = OcrOptions { binarize: Some(true), ..opts_all() };
        let out = preprocess(&encode_png(&image::DynamicImage::ImageRgba8(img)), &opts);
        let gray = image::load_from_memory(&out).unwrap().to_luma8();
        assert!(gray.pixels().all(|p| p[0] == 0 || p[0] == 255));
    }

    /// Tidy fixes engine spacing tics but leaves decimals and hyphens alone.
    #[test]
    fn tidy_fixes_spacing_tics() {
        assert_eq!(tidy("ClipboardView .tsx : 166 ."), "ClipboardView.tsx: 166.");
        assert_eq!(tidy("version 3 . 5 released"), "version 3. 5 released");
        assert_eq!(tidy("state-of-the-art  works"), "state-of-the-art works");
        assert_eq!(tidy("say •hi• twice"), "say \"hi\" twice");
        assert_eq!(tidy("index.ts : 19) ."), "index.ts: 19).");
    }
}
