"""Three bounded read attempts; never log a URL, body or credentials."""
import random
import socket
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError, URLError


def retry_after(value, now):
    if value is None:
        return None
    try:
        seconds = float(value)
        return seconds if 0 <= seconds < float("inf") else None
    except (TypeError, ValueError):
        try:
            return max(0, (parsedate_to_datetime(value) - datetime.fromtimestamp(now, timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None


def read_with_retry(action, sleep=time.sleep, wall_time=time.time, jitter=random.random):
    for attempt in range(3):
        try:
            return action()
        except Exception as error:
            code = error.code if isinstance(error, HTTPError) else None
            transient = code in (408, 429) or (isinstance(code, int) and 500 <= code <= 599)
            network = isinstance(error, (TimeoutError, ConnectionError, socket.timeout)) or (
                isinstance(error, URLError) and isinstance(error.reason, (TimeoutError, ConnectionError, socket.gaierror)))
            delay = retry_after(error.headers.get("Retry-After") if isinstance(error, HTTPError) and error.headers else None, wall_time())
            if isinstance(error, HTTPError):
                error.close()
            if attempt == 2 or not (transient or network) or (delay is not None and delay > 5):
                raise
        sleep(delay if delay is not None else .25 * 2**attempt + jitter()*.25)
