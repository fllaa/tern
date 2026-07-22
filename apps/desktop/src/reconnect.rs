//! Reconnect policy: whether to retry a dropped session, and how long to wait.
//!
//! The async supervisor that drives real reconnects lives in `commands.rs`;
//! the *decisions* live here, pure and tested, because that is where the subtle
//! bugs hide — an off-by-one on the attempt cap, a backoff that overflows a
//! `Duration`, jitter that escapes its bounds. The supervisor is a thin driver
//! that calls [`ReconnectPolicy::decide`], sleeps, and reconnects.

use std::time::Duration;

/// Exponential backoff with full jitter, clamped to a ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    pub base: Duration,
    pub cap: Duration,
    pub factor: u32,
}

impl Backoff {
    /// 500 ms base, doubling, capped at 30 s.
    pub const DEFAULT: Self = Self {
        base: Duration::from_millis(500),
        cap: Duration::from_secs(30),
        factor: 2,
    };

    /// Delay before the `attempt`-th retry (1-based). `rand01` in `[0, 1)` is
    /// the jitter fraction, injected so the schedule is testable.
    ///
    /// Full jitter: the exponential value is the *ceiling*, and the delay is
    /// uniform in `[0, ceiling]`. Full jitter rather than none is what stops a
    /// fleet that all dropped at once — a rebooted switch, a flapping VPN — from
    /// reconnecting in lockstep and turning recovery into a thundering herd.
    ///
    /// Saturating throughout: `factor.pow(attempt)` overflows `u32` by attempt
    /// ~32, and a `Duration` multiply can overflow too. Both clamp rather than
    /// panic, so a session left retrying for days cannot crash the app.
    #[must_use]
    pub fn delay(&self, attempt: u32, rand01: f64) -> Duration {
        let steps = attempt.saturating_sub(1);
        let mult = self.factor.saturating_pow(steps);
        let ceiling = self.base.saturating_mul(mult).min(self.cap);
        // A caller handing us 1.0, a negative, or NaN must not produce a delay
        // outside [0, ceiling]; clamp defensively rather than trust the source.
        let fraction = if rand01.is_finite() {
            rand01.clamp(0.0, 1.0)
        } else {
            0.0
        };
        ceiling.mul_f64(fraction)
    }
}

/// How a session's output pump ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PumpEnd {
    /// The remote shell ended on its own — a clean exit, never retried.
    Exited(Option<u32>),
    /// The transport died under a live shell — the case reconnect exists for.
    Dropped,
}

/// What the supervisor should do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// The shell exited; report the code and stop.
    Exit(Option<u32>),
    /// Wait `delay`, then make reconnect attempt number `attempt`.
    Reconnect { attempt: u32, delay: Duration },
    /// Stop trying; report the session as disconnected.
    GiveUp,
}

/// Per-session reconnect configuration, resolved from host overrides layered
/// over global defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReconnectPolicy {
    pub enabled: bool,
    /// Maximum reconnect attempts. `0` means unlimited.
    pub max_attempts: u32,
    pub backoff: Backoff,
}

impl ReconnectPolicy {
    /// Reconnect on, 10 attempts, default backoff.
    pub const DEFAULT: Self = Self {
        enabled: true,
        max_attempts: 10,
        backoff: Backoff::DEFAULT,
    };

    /// Reconnect never happens — the policy for ad-hoc and local targets, which
    /// have no stored identity to reconnect against.
    pub const OFF: Self = Self {
        enabled: false,
        max_attempts: 0,
        backoff: Backoff::DEFAULT,
    };

    /// Decide the next step after the pump ended.
    ///
    /// `attempt` is the reconnect attempt being *considered* (1-based): 1 right
    /// after a drop, incrementing each time an attempt fails retryably.
    #[must_use]
    pub fn decide(&self, end: PumpEnd, attempt: u32, rand01: f64) -> Decision {
        match end {
            PumpEnd::Exited(code) => Decision::Exit(code),
            PumpEnd::Dropped => self.reconnect_or_give_up(attempt, rand01),
        }
    }

    /// Decide after a reconnect *attempt* itself failed.
    ///
    /// A non-retryable failure ends it immediately: retrying a wrong password
    /// is an account-lockout generator, and retrying a changed host key turns a
    /// security event into background noise (see `SshError::is_retryable`).
    #[must_use]
    pub fn after_failed_attempt(&self, attempt: u32, retryable: bool, rand01: f64) -> Decision {
        if !retryable {
            return Decision::GiveUp;
        }
        self.reconnect_or_give_up(attempt + 1, rand01)
    }

    fn reconnect_or_give_up(&self, attempt: u32, rand01: f64) -> Decision {
        if !self.enabled {
            return Decision::GiveUp;
        }
        // 0 attempts configured is the same as disabled; guard it so a
        // misconfigured host does not spin.
        if self.max_attempts == 0 || attempt > self.max_attempts {
            return Decision::GiveUp;
        }
        Decision::Reconnect {
            attempt,
            delay: self.backoff.delay(attempt, rand01),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Backoff, Decision, PumpEnd, ReconnectPolicy};
    use std::time::Duration;

    #[test]
    fn backoff_grows_exponentially_up_to_the_cap() {
        let b = Backoff {
            base: Duration::from_millis(500),
            cap: Duration::from_secs(30),
            factor: 2,
        };
        // rand01 = 1.0 gives the ceiling exactly (the max of the jitter range).
        assert_eq!(b.delay(1, 1.0), Duration::from_millis(500));
        assert_eq!(b.delay(2, 1.0), Duration::from_secs(1));
        assert_eq!(b.delay(3, 1.0), Duration::from_secs(2));
        // 500ms * 2^9 = 256s, clamped to the 30s cap.
        assert_eq!(b.delay(10, 1.0), Duration::from_secs(30));
    }

    #[test]
    fn full_jitter_stays_within_zero_and_the_ceiling() {
        let b = Backoff::DEFAULT;
        for &r in &[0.0, 0.5, 0.999] {
            let d = b.delay(3, r);
            assert!(d <= Duration::from_secs(2), "{d:?} exceeds ceiling");
        }
        assert_eq!(b.delay(3, 0.0), Duration::ZERO);
    }

    #[test]
    fn a_huge_attempt_count_saturates_instead_of_overflowing() {
        // factor^attempt overflows u32 long before this; must clamp to the cap,
        // not panic.
        assert_eq!(Backoff::DEFAULT.delay(1000, 1.0), Duration::from_secs(30));
    }

    #[test]
    fn out_of_range_jitter_is_clamped_rather_than_trusted() {
        let b = Backoff::DEFAULT;
        assert_eq!(b.delay(2, 5.0), Duration::from_secs(1)); // clamps to 1.0
        assert_eq!(b.delay(2, -1.0), Duration::ZERO); // clamps to 0.0
        assert_eq!(b.delay(2, f64::NAN), Duration::ZERO); // NaN -> 0
    }

    #[test]
    fn a_clean_exit_is_never_reconnected() {
        let p = ReconnectPolicy::DEFAULT;
        assert_eq!(
            p.decide(PumpEnd::Exited(Some(0)), 1, 0.5),
            Decision::Exit(Some(0))
        );
        assert_eq!(
            p.decide(PumpEnd::Exited(None), 1, 0.5),
            Decision::Exit(None)
        );
    }

    #[test]
    fn a_drop_reconnects_when_enabled() {
        let p = ReconnectPolicy::DEFAULT;
        match p.decide(PumpEnd::Dropped, 1, 1.0) {
            Decision::Reconnect { attempt, delay } => {
                assert_eq!(attempt, 1);
                assert_eq!(delay, Duration::from_millis(500));
            }
            other => panic!("expected a reconnect, got {other:?}"),
        }
    }

    #[test]
    fn a_drop_gives_up_when_reconnect_is_off() {
        assert_eq!(
            ReconnectPolicy::OFF.decide(PumpEnd::Dropped, 1, 0.5),
            Decision::GiveUp
        );
    }

    #[test]
    fn attempts_are_bounded_by_the_cap() {
        let p = ReconnectPolicy {
            max_attempts: 3,
            ..ReconnectPolicy::DEFAULT
        };
        assert!(matches!(
            p.decide(PumpEnd::Dropped, 3, 0.5),
            Decision::Reconnect { attempt: 3, .. }
        ));
        // The fourth attempt is one past the cap.
        assert_eq!(p.decide(PumpEnd::Dropped, 4, 0.5), Decision::GiveUp);
    }

    #[test]
    fn a_non_retryable_reconnect_failure_stops_immediately() {
        // A wrong password on reconnect must not be retried, even with attempts
        // to spare — that is the lockout case.
        let p = ReconnectPolicy::DEFAULT;
        assert_eq!(p.after_failed_attempt(1, false, 0.5), Decision::GiveUp);
    }

    #[test]
    fn a_retryable_reconnect_failure_advances_to_the_next_attempt() {
        let p = ReconnectPolicy::DEFAULT;
        match p.after_failed_attempt(1, true, 1.0) {
            Decision::Reconnect { attempt, .. } => assert_eq!(attempt, 2),
            other => panic!("expected the next attempt, got {other:?}"),
        }
    }

    #[test]
    fn a_retryable_failure_at_the_cap_still_gives_up() {
        let p = ReconnectPolicy {
            max_attempts: 2,
            ..ReconnectPolicy::DEFAULT
        };
        // Attempt 2 failed retryably; attempt 3 would exceed the cap.
        assert_eq!(p.after_failed_attempt(2, true, 0.5), Decision::GiveUp);
    }
}
