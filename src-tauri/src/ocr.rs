//! On-demand text recognition for clipboard images (no background work).
//!
//! Windows OCR (no key, no network): PNG bytes → memory stream → BitmapDecoder
//! (downscaled past the engine limit) → Bgra8 → OcrEngine. One engine per call;
//! a screenshot takes a second or two in `spawn_blocking`.

use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat, BitmapTransform, ColorManagementMode,
    ExifOrientationMode, SoftwareBitmap,
};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, IRandomAccessStream, InMemoryRandomAccessStream};
use windows::core::Interface;

pub fn ocr_png(png: &[u8]) -> Result<String, String> {
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| "Texterkennung nicht verfügbar (OCR-Sprachpaket fehlt)".to_string())?;
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
    let mut text = String::new();
    for line in result.Lines().map_err(|e| e.message())? {
        let t = line.Text().map_err(|e| e.message())?.to_string();
        if t.trim().is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(t.trim_end());
    }
    if text.trim().is_empty() {
        return Err("Kein Text erkannt".to_string());
    }
    Ok(text)
}
