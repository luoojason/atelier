"""Transient-failure retry policy for the OpenSwarm scheduler.

Only *pre-response* failures are retried, because a scheduled prompt can trigger
real side effects (e.g. the Publisher agent uploading a video). If the request
reached the server, the run may have already fired its side effect, so retrying
could double it. We therefore retry exactly these cases, none of which imply the
agency ran the prompt:

    * a **connect-phase** failure (the connection was never established, so the
      request never left the client): a raised ``ConnectError`` / ``ConnectTimeout``
      / ``PoolTimeout`` or a bare ``ConnectionError``,
    * ``status_code == 0`` (a response object with no usable status), or
    * HTTP ``429`` (rate-limited: the server rejected the request up front).

Crucially, a **read/write timeout is NOT retried**. ``httpx.ReadTimeout`` (the
most likely failure when a long upload exceeds the client timeout) means the
request already reached the server and may be in flight or complete, so replaying
it would re-fire the exact side effect the 5xx guard exists to prevent. Builtin
``TimeoutError`` is treated the same way (ambiguous, so unsafe). This is why
classifying the *phase* of the exception matters, not merely "did it raise".

All logic here is plain functions with injectable ``sleep`` and ``rand`` so
tests run instantly and deterministically under a bare ``python3``. The defaults
are resolved lazily (from ``time.sleep`` / ``random.random``) at call time, so a
test that patches ``retry.time.sleep`` before the call actually takes effect.
"""

from __future__ import annotations

import random
import time
from typing import Any, Callable, Optional, Tuple

# Statuses that mean "the request never got a real, side-effecting response".
RETRYABLE_STATUS = frozenset({0, 429})

DEFAULT_MAX_RETRIES = 2
DEFAULT_BASE_DELAY = 1.0

# Transport-error class *names* whose failure happened AFTER the request reached
# (or partially reached) the server. Replaying these could double a side effect,
# so they are never retried. Matched by name across the exception's MRO so we do
# not have to hard-import httpx here (it is optional at module load time).
_UNSAFE_EXC_NAMES = frozenset(
    {
        "ReadTimeout",       # httpx: connected, request sent, response too slow
        "WriteTimeout",      # httpx: timed out while sending the request body
        "ReadError",         # httpx: mid-stream read failure
        "WriteError",        # httpx: mid-stream write failure
        "RemoteProtocolError",  # httpx: the server already spoke to us
        # Builtin socket errors that occur AFTER the request left the client:
        # BrokenPipeError means the peer closed while we were writing the body
        # (the request may already be on the server), and ConnectionResetError is
        # a mid-stream reset — both are the same ambiguous write phase as
        # WriteTimeout, so replaying them could double a side effect.
        "BrokenPipeError",
        "ConnectionResetError",
    }
)

# Connect-phase failure class names: the connection was never established, so the
# request never left the client and a retry cannot duplicate a side effect.
_SAFE_EXC_NAMES = frozenset(
    {
        "ConnectError",    # httpx: failed to open the connection
        "ConnectTimeout",  # httpx: timed out opening the connection
        "PoolTimeout",     # httpx: timed out waiting for a free connection
    }
)


def _exc_is_retryable(exc: BaseException) -> bool:
    """True only for connect-phase failures (the request never reached the server).

    Read/write timeouts and other mid-stream transport errors are excluded: the
    request may already be in flight or complete on the server, so replaying it
    could double a real side effect (e.g. a duplicate upload). See module docs.
    """
    names = {klass.__name__ for klass in type(exc).__mro__}
    # A read/write-phase transport error reached the server: never retry.
    if names & _UNSAFE_EXC_NAMES:
        return False
    # Any timeout (builtin TimeoutError, or an httpx.*Timeout not already caught
    # as connect-phase) is ambiguous about whether the request was sent, so it is
    # treated as unsafe. Connect-phase timeouts are whitelisted below first.
    if names & _SAFE_EXC_NAMES:
        return True
    if isinstance(exc, TimeoutError):
        return False
    # Builtin ConnectionError raised while *connecting* (e.g. ConnectionRefusedError
    # — connection refused) never delivered the request, so it is safe to retry.
    # Its write-phase subclasses BrokenPipeError / ConnectionResetError are caught
    # above by _UNSAFE_EXC_NAMES first, so they never reach this branch.
    if isinstance(exc, ConnectionError):
        return True
    return False


def should_retry(status_code: Any, exc: Optional[BaseException]) -> bool:
    """Return True only for pre-response failures that are safe to retry.

    A raised exception is retried only when it is a *connect-phase* failure (the
    request never reached the server); read/write timeouts and other post-send
    errors are left alone. Among HTTP outcomes only ``0`` and ``429`` retry;
    everything else (400, 403, 500, 503, ...) is left alone so a possibly-completed
    side effect is not repeated.
    """
    if exc is not None:
        return _exc_is_retryable(exc)
    return status_code in RETRYABLE_STATUS


def _backoff_delay(base_delay: float, attempt: int, rand: Callable[[], float]) -> float:
    """Exponential backoff (base * 2**(attempt-1)) plus 0..base_delay of jitter."""
    exponential = base_delay * (2 ** (attempt - 1))
    jitter = rand() * base_delay
    return exponential + jitter


def send_with_retry(
    send_callable: Callable[[], Any],
    max_retries: int = DEFAULT_MAX_RETRIES,
    base_delay: float = DEFAULT_BASE_DELAY,
    sleep: Optional[Callable[[float], None]] = None,
    rand: Optional[Callable[[], float]] = None,
) -> Tuple[dict, int]:
    """Call *send_callable* with retries, returning ``(result, attempts)``.

    ``send_callable`` is a zero-arg callable that returns a result dict (with a
    ``status_code``) or raises. On a success or a definite non-retryable
    outcome, the result is returned immediately. Retryable failures back off
    (exponential + jitter) up to *max_retries* additional attempts. If the final
    attempt raised (whether a non-retryable exception or a retryable one that
    exhausted its budget), a synthesized error dict
    ``{"ok": False, "status_code": 0, "error": <str>}`` is returned so callers
    never have to catch here. ``attempts`` is the total number of calls made.

    ``sleep`` and ``rand`` are injectable for deterministic, instant tests. They
    default to ``time.sleep`` / ``random.random`` but are resolved lazily at call
    time, so patching ``retry.time.sleep`` before calling this still takes effect.
    """
    if sleep is None:
        sleep = time.sleep
    if rand is None:
        rand = random.random

    attempts = 0
    last_result: Optional[dict] = None
    last_exc: Optional[BaseException] = None

    while True:
        attempts += 1
        try:
            last_result = send_callable()
            last_exc = None
            if isinstance(last_result, dict):
                status_code = last_result.get("status_code", 0)
            else:
                status_code = 0
        except Exception as exc:  # noqa: BLE001 - classified by should_retry below
            last_exc = exc
            last_result = None
            status_code = 0

        if not should_retry(status_code, last_exc):
            break
        if attempts > max_retries:
            break
        sleep(_backoff_delay(base_delay, attempts, rand))

    # A raised final attempt (non-retryable, or retryable-but-exhausted) is
    # reported as a synthesized error dict rather than propagating.
    if last_exc is not None:
        return {"ok": False, "status_code": 0, "error": str(last_exc)}, attempts
    return last_result, attempts
