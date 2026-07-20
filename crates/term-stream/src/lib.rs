//! Output coalescing (time/size frame batching), and stream statistics —
//! shared by the SSH and local-PTY data paths.
//!
//! Why coalesce: Tauri delivers each IPC channel message ≥ 1 KiB via an
//! internal fetch round-trip, so the hot path must send *fewer, larger*
//! frames. The coalescer flushes on a size threshold OR a short tick,
//! whichever comes first — and flushes immediately when output arrives after
//! an idle gap, so keystroke echo never pays the tick as latency.
//!
//! This is the CI-benchable heart of the terminal data path: it runs without
//! a webview. This crate must never depend on `tauri`.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bytes::{Bytes, BytesMut};
use tokio::sync::mpsc;
use tokio::time::Instant;

/// Coalescer tuning knobs.
#[derive(Debug, Clone, Copy)]
pub struct CoalescerConfig {
    /// Flush as soon as the pending buffer reaches this many bytes.
    pub max_frame: usize,
    /// Flush at least this often while data is pending.
    pub tick: Duration,
}

impl Default for CoalescerConfig {
    fn default() -> Self {
        Self {
            // 128 KiB won the Phase 0 tuning matrix: each >=1 KiB channel frame
            // costs one ordered fetch round-trip, so bigger frames amortize the
            // RTT; 256 KiB bought almost nothing more (docs/bench).
            max_frame: 128 * 1024,
            tick: Duration::from_millis(8),
        }
    }
}

/// Lock-free counters shared between the coalescer, the transport pumps, and
/// benchmark reporting. All counters are cumulative since [`StreamStats::reset`].
#[derive(Debug, Default)]
pub struct StreamStats {
    pub bytes_in: AtomicU64,
    pub newlines_in: AtomicU64,
    pub frames_out: AtomicU64,
    pub bytes_out: AtomicU64,
    pub max_frame_bytes: AtomicU64,
    pub pause_count: AtomicU64,
    pub paused_ms: AtomicU64,
}

impl StreamStats {
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn reset(&self) {
        self.bytes_in.store(0, Ordering::Relaxed);
        self.newlines_in.store(0, Ordering::Relaxed);
        self.frames_out.store(0, Ordering::Relaxed);
        self.bytes_out.store(0, Ordering::Relaxed);
        self.max_frame_bytes.store(0, Ordering::Relaxed);
        self.pause_count.store(0, Ordering::Relaxed);
        self.paused_ms.store(0, Ordering::Relaxed);
    }

    fn record_in(&self, chunk: &[u8]) {
        self.bytes_in
            .fetch_add(chunk.len() as u64, Ordering::Relaxed);
        let newlines = count_newlines(chunk);
        if newlines > 0 {
            self.newlines_in.fetch_add(newlines, Ordering::Relaxed);
        }
    }

    fn record_out(&self, frame_len: usize) {
        self.frames_out.fetch_add(1, Ordering::Relaxed);
        self.bytes_out
            .fetch_add(frame_len as u64, Ordering::Relaxed);
        self.max_frame_bytes
            .fetch_max(frame_len as u64, Ordering::Relaxed);
    }
}

// A plain loop is plenty at terminal rates; not worth a SIMD dependency yet.
#[allow(clippy::naive_bytecount)]
fn count_newlines(chunk: &[u8]) -> u64 {
    chunk.iter().filter(|&&b| b == b'\n').count() as u64
}

/// Runs the coalescing loop: `input` chunks in, batched frames out.
///
/// Returns when `input` closes (after flushing the remainder) or when the
/// consumer side of `output` is dropped. Both channels should be bounded —
/// the bounds are links in the end-to-end backpressure chain.
pub async fn coalesce(
    mut input: mpsc::Receiver<Bytes>,
    output: mpsc::Sender<Bytes>,
    cfg: CoalescerConfig,
    stats: Arc<StreamStats>,
) {
    let mut buf = BytesMut::with_capacity(cfg.max_frame);
    // Start "long ago" so the very first chunk flushes immediately.
    let mut last_flush = Instant::now() - cfg.tick;

    macro_rules! flush {
        () => {
            if !buf.is_empty() {
                let frame = buf.split().freeze();
                stats.record_out(frame.len());
                last_flush = Instant::now();
                if output.send(frame).await.is_err() {
                    return;
                }
            }
        };
    }

    loop {
        if buf.is_empty() {
            // Idle: block for the next chunk.
            let Some(chunk) = input.recv().await else {
                break;
            };
            stats.record_in(&chunk);
            buf.extend_from_slice(&chunk);
            if buf.len() >= cfg.max_frame || last_flush.elapsed() >= cfg.tick {
                // Latency fast-path: output after an idle gap ships at once.
                flush!();
            }
        } else {
            // Pending data: wait for more input or the tick deadline.
            let deadline = last_flush + cfg.tick;
            tokio::select! {
                () = tokio::time::sleep_until(deadline) => {
                    flush!();
                }
                more = input.recv() => {
                    if let Some(chunk) = more {
                        stats.record_in(&chunk);
                        buf.extend_from_slice(&chunk);
                        if buf.len() >= cfg.max_frame {
                            flush!();
                        }
                    } else {
                        break;
                    }
                }
            }
        }
    }

    // Input closed: ship whatever is left (no cadence bookkeeping needed).
    if !buf.is_empty() {
        let frame = buf.split().freeze();
        stats.record_out(frame.len());
        let _ = output.send(frame).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> CoalescerConfig {
        CoalescerConfig {
            max_frame: 1024,
            tick: Duration::from_millis(8),
        }
    }

    #[tokio::test]
    async fn idle_chunk_flushes_immediately() {
        let (in_tx, in_rx) = mpsc::channel(8);
        let (out_tx, mut out_rx) = mpsc::channel(8);
        let stats = StreamStats::new();
        tokio::spawn(coalesce(in_rx, out_tx, cfg(), Arc::clone(&stats)));

        let started = Instant::now();
        in_tx
            .send(Bytes::from_static(b"echo\n"))
            .await
            .expect("send");
        let frame = out_rx.recv().await.expect("frame");
        assert_eq!(&frame[..], b"echo\n");
        assert!(
            started.elapsed() < Duration::from_millis(6),
            "idle chunk must not wait for the tick (took {:?})",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn oversize_burst_splits_into_bounded_frames() {
        let (in_tx, in_rx) = mpsc::channel(64);
        let (out_tx, mut out_rx) = mpsc::channel(64);
        let stats = StreamStats::new();
        tokio::spawn(coalesce(in_rx, out_tx, cfg(), Arc::clone(&stats)));

        // 10 KiB in 512-byte chunks against a 1 KiB max_frame.
        for i in 0..20u8 {
            in_tx.send(Bytes::from(vec![i; 512])).await.expect("send");
        }
        drop(in_tx);

        let mut total = 0usize;
        let mut frame_count = 0usize;
        while let Some(frame) = out_rx.recv().await {
            assert!(
                frame.len() <= 1024 + 512,
                "frame way over max: {}",
                frame.len()
            );
            total += frame.len();
            frame_count += 1;
        }
        assert_eq!(total, 20 * 512);
        assert!(
            frame_count >= 5,
            "expected multiple bounded frames, got {frame_count}"
        );
        assert_eq!(stats.bytes_in.load(Ordering::Relaxed), 20 * 512);
        assert_eq!(stats.bytes_out.load(Ordering::Relaxed), 20 * 512);
    }

    #[tokio::test]
    #[allow(clippy::cast_possible_truncation)] // deliberate u8 wrapping for test data
    async fn byte_integrity_across_random_chunking() {
        let (in_tx, in_rx) = mpsc::channel(64);
        let (out_tx, mut out_rx) = mpsc::channel(64);
        let stats = StreamStats::new();
        tokio::spawn(coalesce(in_rx, out_tx, cfg(), Arc::clone(&stats)));

        let mut expected = Vec::new();
        // Deterministic pseudo-random chunk sizes (no external RNG dep).
        let mut seed = 0x9e37_79b9_u32;
        for _ in 0..200 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let len = (seed % 700 + 1) as usize;
            let chunk: Vec<u8> = (0..len).map(|i| (seed as usize + i) as u8).collect();
            expected.extend_from_slice(&chunk);
            in_tx.send(Bytes::from(chunk)).await.expect("send");
        }
        drop(in_tx);

        let mut got = Vec::new();
        while let Some(frame) = out_rx.recv().await {
            got.extend_from_slice(&frame);
        }
        assert_eq!(got, expected, "coalescer must preserve every byte in order");
        assert_eq!(
            stats.newlines_in.load(Ordering::Relaxed),
            count_newlines(&expected)
        );
    }
}
