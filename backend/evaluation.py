"""Optional observation seam for the real text pipeline.

No sink is installed by the normal product entrypoint. An explicitly isolated
runner may install a sink; this module never retains provider reasoning fields,
credentials, raw provider responses, or audio. The sink owns data retention.
"""
import copy
import datetime as dt
import time


class AIObservation:
    def __init__(self, sink=None, **identity):
        self.sink = sink
        self.identity = identity
        self.started = time.monotonic()

    def emit(self, kind, data, *, stage=None, attempt=None):
        if self.sink is None:
            return
        self.sink({
            'kind': kind,
            'at': dt.datetime.now(dt.timezone.utc).isoformat(),
            'elapsed_ms': round((time.monotonic() - self.started) * 1000, 3),
            **self.identity,
            'stage': stage,
            'attempt': attempt,
            'data': copy.deepcopy(data),
        })


def visible_provider_response(result):
    """Explicit allowlist: content is observable; reasoning_content never is."""
    choices = result.get('choices')
    choice = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
    message = choice.get('message')
    message = message if isinstance(message, dict) else {}
    usage = result.get('usage')
    usage = usage if isinstance(usage, dict) else {}
    counts = {k: usage[k] for k in ('prompt_tokens', 'completion_tokens', 'total_tokens',
                                   'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens')
              if type(usage.get(k)) is int}
    details = usage.get('completion_tokens_details')
    if isinstance(details, dict) and type(details.get('reasoning_tokens')) is int:
        counts['reasoning_tokens'] = details['reasoning_tokens']
    return {
        'model': result.get('model') if isinstance(result.get('model'), str) else None,
        'provider_request_id': result.get('id') if isinstance(result.get('id'), str) else None,
        'finish_reason': choice.get('finish_reason'),
        'content': message.get('content') if isinstance(message.get('content'), str) else None,
        'refusal': message.get('refusal') if isinstance(message.get('refusal'), str) else None,
        'reasoning_field_present': 'reasoning_content' in message,
        'reasoning_content_nonempty': isinstance(message.get('reasoning_content'), str) and bool(message['reasoning_content']),
        'usage': counts or None,
        'usage_status': ('reported' if all(key in counts for key in ('prompt_tokens', 'completion_tokens', 'total_tokens'))
                         else 'partial' if counts else 'missing'),
        'ttft_ms': None,
        'ttft_status': 'unknown_non_streaming',
        'effective_reasoning_effort': None,
        'effective_thinking': None,
    }
