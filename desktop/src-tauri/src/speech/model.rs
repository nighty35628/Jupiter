use super::{Download, SpeechState, MODEL_BYTES, MODEL_SHA256, MODEL_URL};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub(super) fn verify_file(path: &Path, cancelled: &AtomicBool) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| "speech_model_missing")?;
    if !meta.file_type().is_file() || meta.len() != MODEL_BYTES {
        return Err("speech_model_integrity_failed".into());
    }
    let file = std::fs::File::open(path).map_err(|_| "speech_model_unreadable")?;
    let mut reader = std::io::BufReader::new(file.take(MODEL_BYTES + 1));
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut buf = [0u8; 65_536];
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err("speech_cancelled".into());
        }
        let count = reader
            .read(&mut buf)
            .map_err(|_| "speech_model_unreadable")?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        hash.update(&buf[..count]);
    }
    verify_digest(
        bytes,
        &format!("{:x}", hash.finalize()),
        MODEL_BYTES,
        MODEL_SHA256,
    )
}

fn verify_digest(
    bytes: u64,
    hash: &str,
    expected_bytes: u64,
    expected_hash: &str,
) -> Result<(), String> {
    if bytes != expected_bytes || hash != expected_hash {
        return Err("speech_model_integrity_failed".into());
    }
    Ok(())
}

struct DownloadLease {
    state: SpeechState,
    ticket: Arc<Download>,
    part: PathBuf,
}

impl Drop for DownloadLease {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.part);
        let mut inner = self.state.0.inner.lock();
        if inner
            .download
            .as_ref()
            .is_some_and(|job| Arc::ptr_eq(job, &self.ticket))
        {
            inner.download = None;
        }
    }
}

impl SpeechState {
    pub(super) fn verify_cached_model(&self) {
        let state = self.clone();
        let epoch = self.0.inner.lock().model_epoch;
        let _ = std::thread::Builder::new()
            .name("jupiter-speech-model-check".into())
            .spawn(move || {
                let ready = verify_file(&state.0.model_path, &state.0.shutdown).is_ok();
                let mut inner = state.0.inner.lock();
                if inner.model_epoch == epoch && inner.download.is_none() {
                    inner.model_ready = ready;
                    // Only our private, abandoned partial files; never a published model.
                    if let Some(parent) = state.0.model_path.parent() {
                        if let Ok(entries) = std::fs::read_dir(parent) {
                            for entry in entries.flatten() {
                                let name = entry.file_name();
                                let name = name.to_string_lossy();
                                if name.starts_with("ggml-base.download-")
                                    && name.ends_with(".part")
                                {
                                    let _ = std::fs::remove_file(entry.path());
                                }
                            }
                        }
                    }
                }
            });
    }

    fn reserve_download(&self) -> Result<DownloadLease, String> {
        let mut inner = self.0.inner.lock();
        if self.0.shutdown.load(Ordering::SeqCst) {
            return Err("speech_shutting_down".into());
        }
        if inner.session.is_some() {
            return Err("speech_busy_cleanup_pending".into());
        }
        if inner.download.is_some() {
            return Err("speech_model_download_busy".into());
        }
        inner.model_epoch = inner
            .model_epoch
            .checked_add(1)
            .ok_or("speech_model_generation_limit")?;
        let ticket = Arc::new(Download {
            epoch: inner.model_epoch,
            cancelled: AtomicBool::new(false),
            bytes: AtomicU64::new(0),
            wake: tokio::sync::Notify::new(),
        });
        inner.download = Some(ticket.clone());
        Ok(DownloadLease {
            state: self.clone(),
            part: self.0.model_path.with_file_name(format!(
                "ggml-base.download-{}-{}.part",
                std::process::id(),
                ticket.epoch
            )),
            ticket,
        })
    }

    fn publish_download(&self, ticket: &Arc<Download>, part: &Path) -> Result<(), String> {
        let mut inner = self.0.inner.lock();
        if ticket.cancelled.load(Ordering::SeqCst)
            || self.0.shutdown.load(Ordering::SeqCst)
            || ticket.epoch != inner.model_epoch
            || !inner
                .download
                .as_ref()
                .is_some_and(|job| Arc::ptr_eq(job, ticket))
        {
            return Err("speech_model_download_cancelled".into());
        }
        // Serialized with removal, so a late rename cannot resurrect a removed model.
        std::fs::rename(part, &self.0.model_path).map_err(|_| "speech_model_publish_failed")?;
        inner.model_ready = true;
        Ok(())
    }

    pub(super) async fn download_model(&self) -> Result<(), String> {
        if self.0.inner.lock().model_ready {
            return Ok(());
        }
        let lease = self.reserve_download()?;
        tokio::select! {
            biased;
            _ = lease.ticket.wake.notified() => Err("speech_model_download_cancelled".into()),
            result = self.transfer_model(&lease) => result,
        }
    }

    async fn transfer_model(&self, lease: &DownloadLease) -> Result<(), String> {
        if lease.ticket.cancelled.load(Ordering::SeqCst) {
            return Err("speech_model_download_cancelled".into());
        }
        let parent = self
            .0
            .model_path
            .parent()
            .ok_or("speech_model_path_unavailable")?;
        std::fs::create_dir_all(parent).map_err(|_| "speech_model_directory_failed")?;
        if fs2::available_space(parent).map_err(|_| "speech_model_space_check_failed")?
            < MODEL_BYTES + 16 * 1024 * 1024
        {
            return Err("speech_model_insufficient_space".into());
        }
        let client = reqwest::Client::builder()
            .https_only(true)
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(15 * 60))
            .referer(false)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let url = attempt.url();
                let host = url.host_str().unwrap_or("");
                if attempt.previous().len() >= 5
                    || url.scheme() != "https"
                    || url.port_or_known_default() != Some(443)
                    || !(host == "huggingface.co"
                        || host.ends_with(".huggingface.co")
                        || host.ends_with(".hf.co"))
                {
                    attempt.error("model redirect refused")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| "speech_model_http_unavailable")?;
        let mut response = client
            .get(MODEL_URL)
            .send()
            .await
            .map_err(|_| "speech_model_download_failed")?;
        if response.status() != reqwest::StatusCode::OK {
            return Err("speech_model_http_error".into());
        }
        if response
            .content_length()
            .is_some_and(|size| size != MODEL_BYTES)
        {
            return Err("speech_model_size_mismatch".into());
        }
        // Synchronous file ownership is intentional. Dropping a Tokio fs future
        // does not stop its blocking open/write; that could recreate a removed
        // partial file after our cancellation cleanup had already finished.
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&lease.part)
            .map_err(|_| "speech_model_temp_failed")?;
        let mut hash = Sha256::new();
        let mut size = 0u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "speech_model_download_failed")?
        {
            size = size
                .checked_add(chunk.len() as u64)
                .ok_or("speech_model_size_mismatch")?;
            if size > MODEL_BYTES {
                return Err("speech_model_size_mismatch".into());
            }
            file.write_all(&chunk)
                .map_err(|_| "speech_model_write_failed")?;
            hash.update(&chunk);
            lease.ticket.bytes.store(size, Ordering::Relaxed);
        }
        verify_digest(
            size,
            &format!("{:x}", hash.finalize()),
            MODEL_BYTES,
            MODEL_SHA256,
        )?;
        file.flush().map_err(|_| "speech_model_write_failed")?;
        file.sync_all().map_err(|_| "speech_model_write_failed")?;
        drop(file);
        self.publish_download(&lease.ticket, &lease.part)
    }

    pub(super) fn remove_model(&self) -> Result<(), String> {
        let mut inner = self.0.inner.lock();
        // Includes cancelled but still loading/decoding workers.
        if inner.session.is_some() {
            return Err("speech_busy_cleanup_pending".into());
        }
        inner.model_epoch = inner
            .model_epoch
            .checked_add(1)
            .ok_or("speech_model_generation_limit")?;
        if let Some(download) = &inner.download {
            download.cancel();
        }
        inner.model_ready = false;
        match std::fs::remove_file(&self.0.model_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("speech_model_remove_failed".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech::tests::Harness;

    #[test]
    fn exact_length_and_sha_are_both_required() {
        let hash = format!("{:x}", Sha256::digest(b"test"));
        assert!(verify_digest(4, &hash, 4, &hash).is_ok());
        assert!(verify_digest(3, &hash, 4, &hash).is_err());
        assert!(verify_digest(4, "bad", 4, &hash).is_err());
    }

    #[test]
    fn removal_before_publication_invalidates_even_fully_verified_download() {
        let h = Harness::new(false);
        let lease = h.state.reserve_download().unwrap();
        std::fs::write(&lease.part, b"verified-fixture").unwrap();
        h.state.remove_model().unwrap();
        assert!(h
            .state
            .publish_download(&lease.ticket, &lease.part)
            .is_err());
        assert!(!h.state.0.model_path.exists());
        assert!(!h.state.capabilities().model_ready);
        assert!(h.state.reserve_download().is_err());
        drop(lease);
        assert!(h.state.reserve_download().is_ok());
    }

    #[test]
    fn removal_after_publication_wins_and_old_cleanup_cannot_clear_next_download() {
        let h = Harness::new(false);
        let lease = h.state.reserve_download().unwrap();
        std::fs::write(&lease.part, b"verified-fixture").unwrap();
        h.state
            .publish_download(&lease.ticket, &lease.part)
            .unwrap();
        h.state.remove_model().unwrap();
        drop(lease);
        let next = h.state.reserve_download().unwrap();
        let old = Arc::new(Download {
            epoch: 0,
            cancelled: AtomicBool::new(false),
            bytes: AtomicU64::new(0),
            wake: tokio::sync::Notify::new(),
        });
        let old_cleanup = DownloadLease {
            state: h.state.clone(),
            ticket: old,
            part: h.root.join("old.part"),
        };
        drop(old_cleanup);
        assert!(h
            .state
            .0
            .inner
            .lock()
            .download
            .as_ref()
            .is_some_and(|d| Arc::ptr_eq(d, &next.ticket)));
        assert!(!h.state.0.model_path.exists());
    }

    #[test]
    fn failed_download_preserves_published_model_and_allows_retry() {
        let h = Harness::new(false);
        std::fs::write(&h.state.0.model_path, b"existing-model").unwrap();
        let lease = h.state.reserve_download().unwrap();
        std::fs::write(&lease.part, b"truncated").unwrap();
        assert!(verify_digest(9, "bad", MODEL_BYTES, MODEL_SHA256).is_err());
        let part = lease.part.clone();
        drop(lease);
        assert!(!part.exists());
        assert_eq!(
            std::fs::read(&h.state.0.model_path).unwrap(),
            b"existing-model"
        );
        assert!(h.state.reserve_download().is_ok());
    }

    #[test]
    fn cancellation_before_future_is_polled_is_not_lost() {
        let h = Harness::new(false);
        let lease = h.state.reserve_download().unwrap();
        h.state.remove_model().unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_millis(100), lease.ticket.wake.notified())
                .await
                .unwrap();
            assert!(h.state.transfer_model(&lease).await.is_err());
        });
    }
}
