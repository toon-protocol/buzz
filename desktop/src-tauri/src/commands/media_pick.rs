use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;

use super::media::{
    detect_and_validate_mime, do_upload, fd_real_path, sanitize_filename,
    sanitize_image_for_upload, BlobDescriptor,
};
use super::media_transcode::{
    has_heic_extension, is_heic_file, is_video_file, transcode_and_extract_poster,
    transcode_heic_path_to_jpeg_bytes,
};

/// Read a picked path through the TOCTOU-safe pipeline (fd pin → sniff →
/// transcode-or-passthrough → MIME validation → upload).
///
/// When `images_only` is set, the file is rejected **before upload** if it is
/// not an image (videos and non-image files error out; HEIC/HEIF still
/// transcode to JPEG, which is an image). This keeps discarded/non-image
/// files from ever leaving the client on image-only surfaces.
async fn process_picked_path(
    path: std::path::PathBuf,
    state: &AppState,
    images_only: bool,
) -> Result<BlobDescriptor, String> {
    let prepared = prepare_picked_path(path, images_only).await?;

    // Upload video first, then poster (best-effort). If poster upload fails,
    // the video descriptor is returned without an image field.
    let mut descriptor = do_upload(prepared.body, &prepared.mime, state, None).await?;

    if let Some(poster) = prepared.poster_bytes {
        match do_upload(poster, "image/jpeg", state, None).await {
            Ok(poster_desc) => descriptor.image = Some(poster_desc.url),
            Err(e) => eprintln!("buzz-desktop: poster upload failed (non-fatal): {e}"),
        }
    }

    descriptor.filename = prepared.filename;

    Ok(descriptor)
}

/// A picked file, run through the whole pre-upload pipeline but not sent
/// anywhere. What `process_picked_path` uploads, and what `pick_media_bytes`
/// hands to the renderer.
pub(crate) struct PreparedMedia {
    pub(crate) body: Vec<u8>,
    pub(crate) mime: String,
    /// Extracted first frame for videos, to be uploaded as the NIP-71 poster.
    pub(crate) poster_bytes: Option<Vec<u8>>,
    pub(crate) filename: Option<String>,
}

/// Read a picked path through the TOCTOU-safe pipeline (fd pin → sniff →
/// transcode-or-passthrough → MIME validation), stopping short of the upload.
///
/// Split out of `process_picked_path` so a second media backend can reuse the
/// preparation without inheriting Blossom's destination. Everything that
/// protects the user — inode pinning, magic-byte sniffing, the deny-list, image
/// sanitisation, the `images_only` gate — happens here, so no backend can skip
/// it by not calling the uploader.
pub(crate) async fn prepare_picked_path(
    path: std::path::PathBuf,
    images_only: bool,
) -> Result<PreparedMedia, String> {
    // Pin the inode by opening the fd BEFORE spawn_blocking. This prevents a
    // local attacker from swapping the file between dialog return and read.
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;

    // Extension hint for HEIC detection — some HEIC files from non-Apple
    // tooling carry brands outside HEIC_BRANDS, but the `.heic`/`.heif`
    // extension still tells us the webview can't render them. Computed before
    // the closure since `path` isn't moved in.
    let heic_by_ext = has_heic_extension(&path);

    // All sync I/O (sniff, transcode, read) runs off the async runtime to
    // avoid blocking Tokio worker threads during long ffmpeg transcodes.
    let (body, poster_bytes) =
        tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, Option<Vec<u8>>), String> {
            use std::io::Read;

            // Sniff magic bytes from the pinned fd — no re-open, no TOCTOU.
            let mut header = [0u8; 4096];
            let n = file.read(&mut header).map_err(|e| e.to_string())?;

            if is_video_file(&header[..n]) {
                if images_only {
                    return Err("Please choose an image file.".to_string());
                }
                // ffmpeg needs a path, not an fd. Resolve the fd's real path
                // so we pass the actual inode's location, not the original
                // (potentially swapped) pathname. Same pattern as upload_media.
                // IMPORTANT: keep `file` alive (fd open) until after transcode
                // completes — this prevents the inode from being unlinked or
                // the resolved path from becoming stale during the ffmpeg run.
                let fd_path = fd_real_path(&file)?;
                let result = transcode_and_extract_poster(&fd_path);
                drop(file); // release fd only after ffmpeg is done
                result
            } else if heic_by_ext || is_heic_file(&header[..n]) {
                // HEIC/HEIF still: Chromium/the webview can't decode it, so
                // transcode to JPEG before upload (mirrors mobile). Resolve the
                // fd's real path so ffmpeg reads the pinned inode, and keep
                // `file` alive until the transcode finishes.
                let fd_path = fd_real_path(&file)?;
                let result = transcode_heic_path_to_jpeg_bytes(&fd_path).map(|jpeg| (jpeg, None));
                drop(file); // release fd only after ffmpeg is done
                result
            } else {
                // Image: read the rest from the already-open fd (TOCTOU-safe).
                let mut bytes = header[..n].to_vec();
                file.read_to_end(&mut bytes)
                    .map_err(|e| format!("failed to read file: {e}"))?;
                Ok((bytes, None))
            }
        })
        .await
        .map_err(|e| format!("transcode task failed: {e}"))??;

    let mime = detect_and_validate_mime(&body)?;
    let body = sanitize_image_for_upload(body, &mime)?;

    // Image-only surfaces (e.g. "Send feedback"): reject anything that didn't
    // sniff as an image, BEFORE the upload leaves the client.
    if images_only && !mime.starts_with("image/") {
        return Err("Please choose an image file.".to_string());
    }

    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(sanitize_filename);

    Ok(PreparedMedia {
        body,
        mime,
        poster_bytes,
        filename,
    })
}

/// Open a native file dialog (multi-select), read each selected file, and
/// upload it. Returns the resulting `BlobDescriptor` list — empty when the
/// user cancels.
///
/// All file I/O happens in trusted Rust — the renderer never touches the
/// filesystem. This is the secure path for the 📎 paperclip button.
///
/// **Residual TOCTOU note:** The Tauri dialog plugin returns pathnames, not
/// file handles, so there is a small race window between dialog return and
/// `File::open()` — an inherent limit of the OS file-picker API. The risk is
/// bounded (local attacker winning a race against an immediate open) and
/// server-side content validation (MIME, image decode, size caps) is the
/// defense in depth.
///
/// Uploads run sequentially; on first failure, prior uploads are not
/// rolled back (they're already content-addressed on the relay).
#[tauri::command]
pub async fn pick_and_upload_media(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<BlobDescriptor>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    // No filter — accept any file. The deny-list (active content + executables)
    // and size caps are enforced by `detect_and_validate_mime` and the relay.
    app.dialog().file().pick_files(move |paths| {
        let _ = tx.send(paths);
    });

    let file_paths = match rx.await.map_err(|_| "dialog cancelled".to_string())? {
        Some(paths) => paths,
        None => return Ok(Vec::new()),
    };

    let mut descriptors = Vec::with_capacity(file_paths.len());
    for file_path in file_paths {
        let path = file_path.as_path().ok_or("invalid path")?.to_path_buf();
        let descriptor = process_picked_path(path, &state, false).await?;
        descriptors.push(descriptor);
    }

    Ok(descriptors)
}

/// Open a native single-file dialog constrained to images, read the picked
/// file, and upload it — rejecting anything that doesn't sniff as an image
/// **before** the bytes leave the client.
///
/// This is the secure path for image-only surfaces (e.g. the "Send feedback"
/// attachment). Unlike [`pick_and_upload_media`], the dialog is filtered to
/// common image extensions and `process_picked_path` runs with
/// `images_only = true`, so a user who bypasses the extension filter still
/// can't upload a non-image (videos and other files error out during MIME
/// validation, before `do_upload`). Returns `None` when the user cancels.
#[tauri::command]
pub async fn pick_and_upload_image(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<BlobDescriptor>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(
            "Images",
            &["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp"],
        )
        .pick_file(move |path| {
            let _ = tx.send(path);
        });

    let file_path = match rx.await.map_err(|_| "dialog cancelled".to_string())? {
        Some(path) => path,
        None => return Ok(None),
    };

    let path = file_path.as_path().ok_or("invalid path")?.to_path_buf();
    let descriptor = process_picked_path(path, &state, true).await?;
    Ok(Some(descriptor))
}

/// A picked file's prepared bytes, handed to the renderer instead of to the
/// relay. Mirrors the fields of [`BlobDescriptor`] that exist before an upload
/// has happened — there is no URL or hash yet, because nothing has been stored.
#[derive(Debug, Clone, Serialize)]
pub struct PickedMedia {
    pub data: Vec<u8>,
    #[serde(rename = "type")]
    pub mime_type: String,
    pub filename: Option<String>,
}

/// Open a native file dialog (multi-select) and return each file's prepared
/// bytes **without uploading them**.
///
/// The pick-and-prepare half of [`pick_and_upload_media`], for backends that do
/// not live behind the relay's Blossom endpoint — today the TOON store node,
/// whose uploads are paid ILP writes issued from the renderer (ADR 0002). File
/// I/O still happens only in Rust: the renderer receives bytes, never paths,
/// and every file has already been sniffed, transcoded if needed, validated
/// against the deny-list, and sanitised.
///
/// Returns an empty list when the user cancels.
///
/// Known gap: a video's extracted poster frame is dropped rather than returned.
/// On Blossom the poster is a second, free upload; on the store node it would
/// be a second *paid* one, which the caller has not been quoted for. Videos
/// therefore arrive posterless on the store path until the quote covers both.
#[tauri::command]
pub async fn pick_media_bytes(app: tauri::AppHandle) -> Result<Vec<PickedMedia>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |paths| {
        let _ = tx.send(paths);
    });

    let file_paths = match rx.await.map_err(|_| "dialog cancelled".to_string())? {
        Some(paths) => paths,
        None => return Ok(Vec::new()),
    };

    let mut picked = Vec::with_capacity(file_paths.len());
    for file_path in file_paths {
        let path = file_path.as_path().ok_or("invalid path")?.to_path_buf();
        let prepared = prepare_picked_path(path, false).await?;
        picked.push(PickedMedia {
            data: prepared.body,
            mime_type: prepared.mime,
            filename: prepared.filename,
        });
    }

    Ok(picked)
}
