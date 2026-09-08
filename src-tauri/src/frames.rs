//! Frame-edge time for a constant frame rate, in the START/END convention the reference uses, so a
//! split at the playhead lands on a frame boundary rather than the millisecond the clock happened to
//! read. The formulas are the reference's, distilled for a constant `fps`. See
//! sublore-meta/docs/split-at-playhead-tasks.md, including the one honest divergence: the
//! reference's rate is rational and Sublore's `fps` is a float, so fractional NTSC rates are
//! frame-accurate to about a millisecond rather than exact.

/// Which edge of a frame a time is read as. A subtitle start snaps to a frame differently from an
/// end, which is the whole reason the two exist.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Start,
    End,
}

/// The millisecond a frame's own timecode falls at, for a constant `fps` (positive).
fn time_at_frame(frame: i64, fps: f64) -> i64 {
    ((frame as f64) * 1000.0 / fps).round() as i64
}

/// The millisecond a frame's chosen edge falls at: START is the midpoint before the frame's
/// timecode, END the midpoint after it, both rounded up, as the reference does it.
pub fn time_at_frame_edge(frame: i64, fps: f64, edge: Edge) -> i64 {
    match edge {
        Edge::Start => {
            let prev = time_at_frame(frame - 1, fps);
            let cur = time_at_frame(frame, fps);
            prev + (cur - prev + 1) / 2
        }
        Edge::End => {
            let cur = time_at_frame(frame, fps);
            let next = time_at_frame(frame + 1, fps);
            cur + (next - cur + 1) / 2
        }
    }
}

/// The largest frame whose own timecode is at or before `ms`.
fn frame_at_time_exact(ms: i64, fps: f64) -> i64 {
    ((ms as f64) * fps / 1000.0).floor() as i64
}

/// The frame a time reads as at the chosen edge. START and END ranges are adjacent, so END is the
/// exact frame one millisecond earlier and START is that plus one, the reference's own identity.
pub fn frame_at_time_edge(ms: i64, fps: f64, edge: Edge) -> i64 {
    let base = frame_at_time_exact(ms - 1, fps);
    match edge {
        Edge::Start => base + 1,
        Edge::End => base,
    }
}

/// What a playhead split writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitAt {
    /// The first cue becomes `[start, first_end_ms]`, the second `[second_start_ms, end]`, with the
    /// original text in both.
    Between {
        first_end_ms: u32,
        second_start_ms: u32,
    },
    /// The playhead is not inside the cue, so a split is meaningless: the reference makes the new cue
    /// just the current frame. The caller decides whether to offer it.
    Degenerate {
        frame_start_ms: u32,
        frame_end_ms: u32,
    },
}

/// The two boundaries a playhead split writes for a cue, given the playhead and the frame rate.
///
/// `before` is the reference's "split before the current frame": the first cue ends on the previous
/// frame and the second starts on the current one. Without it ("after"), the first ends on the
/// current frame and the second starts on the next.
pub fn split_at_playhead(
    start_ms: u32,
    end_ms: u32,
    playhead_ms: u32,
    fps: f64,
    before: bool,
) -> SplitAt {
    let cur = frame_at_time_exact(playhead_ms as i64, fps);
    let start_frame = frame_at_time_edge(start_ms as i64, fps, Edge::Start);
    let end_frame = frame_at_time_edge(end_ms as i64, fps, Edge::End);
    if cur < start_frame || cur > end_frame {
        let clamp = |ms: i64| ms.max(0) as u32;
        return SplitAt::Degenerate {
            frame_start_ms: clamp(time_at_frame_edge(cur, fps, Edge::Start)),
            frame_end_ms: clamp(time_at_frame_edge(cur, fps, Edge::End)),
        };
    }
    let (first_end, second_start) = if before {
        (
            time_at_frame_edge(cur - 1, fps, Edge::End),
            time_at_frame_edge(cur, fps, Edge::Start),
        )
    } else {
        (
            time_at_frame_edge(cur, fps, Edge::End),
            time_at_frame_edge(cur + 1, fps, Edge::Start),
        )
    };
    SplitAt::Between {
        first_end_ms: first_end.max(0) as u32,
        second_start_ms: second_start.max(0) as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Twenty-five frames a second: one frame is 40 ms, so the arithmetic is exact and easy to pin.
    const FPS: f64 = 25.0;

    #[test]
    fn a_frame_edge_is_the_midpoint_around_its_timecode() {
        // Frame 10's timecode is 400 ms; START is the midpoint before it, END the midpoint after.
        assert_eq!(time_at_frame_edge(10, FPS, Edge::Start), 380);
        assert_eq!(time_at_frame_edge(10, FPS, Edge::End), 420);
        // Frame 0 begins before zero: its START midpoint is half a frame back, which callers clamp.
        assert_eq!(time_at_frame_edge(0, FPS, Edge::Start), -20);
    }

    #[test]
    fn a_time_reads_as_the_frame_its_edge_falls_on() {
        // A start at 400 ms shows on frame 10; an end at 400 ms shows through frame 9.
        assert_eq!(frame_at_time_edge(400, FPS, Edge::Start), 10);
        assert_eq!(frame_at_time_edge(400, FPS, Edge::End), 9);
    }

    #[test]
    fn after_splits_on_the_current_frames_far_edge_and_before_on_its_near_edge() {
        // Cue [0, 1000], playhead on frame 10 (400 ms). After the current frame splits at frame 10's
        // end, before at its start.
        assert_eq!(
            split_at_playhead(0, 1000, 400, FPS, false),
            SplitAt::Between {
                first_end_ms: 420,
                second_start_ms: 420,
            }
        );
        assert_eq!(
            split_at_playhead(0, 1000, 400, FPS, true),
            SplitAt::Between {
                first_end_ms: 380,
                second_start_ms: 380,
            }
        );
    }

    #[test]
    fn a_playhead_outside_the_cue_is_the_degenerate_case() {
        // Cue [0, 200] (frames 0..5), playhead at 400 ms (frame 10): outside, so the new cue is just
        // that frame.
        assert_eq!(
            split_at_playhead(0, 200, 400, FPS, false),
            SplitAt::Degenerate {
                frame_start_ms: 380,
                frame_end_ms: 420,
            }
        );
    }
}
