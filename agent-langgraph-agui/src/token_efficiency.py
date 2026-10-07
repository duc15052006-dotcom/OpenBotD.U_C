"""Provider-view token controls.

These helpers change only the messages handed to the model. LangGraph state and the
OpenBot/Intelligence transcript stay complete, so saving tokens never deletes history.
"""

import os
import re

DEFAULT_HISTORY_USER_TURNS = 6
DEFAULT_TOOL_RESULT_CHARS = 12_000
DEFAULT_QWEN3_MAX_OUTPUT_TOKENS = 4_096

_QWEN3 = re.compile(r"(^|[/:._-])qwen3([/:._-]|$)", re.IGNORECASE)
_TRUE = {"1", "true", "yes", "on", "enabled"}


def qwen3_model(model: str | None) -> bool:
    return bool(_QWEN3.search((model or "").strip()))


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return min(max(value, minimum), maximum)


def qwen3_max_output_tokens() -> int:
    """A hard per-call ceiling for Qwen3 compatible endpoints.

    Qwen hybrid-thinking models can otherwise consume tens of thousands of output/reasoning
    tokens before a tiny tool call. This stays overrideable for deliberately long generations.
    """
    return _bounded_int(
        "OPENBOT_QWEN_MAX_OUTPUT_TOKENS",
        DEFAULT_QWEN3_MAX_OUTPUT_TOKENS,
        256,
        32_768,
    )


def qwen3_non_thinking_enabled(model: str | None) -> bool:
    if not qwen3_model(model):
        return False
    return (os.environ.get("OPENBOT_QWEN_THINKING") or "").strip().lower() not in _TRUE


def _role(message) -> str:
    if isinstance(message, dict):
        role = message.get("role")
        return role if isinstance(role, str) else ""
    kind = getattr(message, "type", "")
    return {
        "human": "user",
        "ai": "assistant",
    }.get(kind, kind if isinstance(kind, str) else "")


def _content(message):
    if isinstance(message, dict):
        return message.get("content")
    return getattr(message, "content", None)


def _with_content(message, content):
    if isinstance(message, dict):
        return {**message, "content": content}
    copier = getattr(message, "model_copy", None)
    if callable(copier):
        return copier(update={"content": content})
    return message


def _text_parts(content):
    if isinstance(content, str):
        yield content
        return
    if not isinstance(content, list):
        return
    for part in content:
        if isinstance(part, str):
            yield part
        elif isinstance(part, dict):
            text = part.get("text")
            if isinstance(text, str):
                yield text


def _append_no_think(content):
    if any("/no_think" in text.lower() for text in _text_parts(content)):
        return content
    if isinstance(content, str):
        return f"{content}\n\n/no_think"
    if isinstance(content, list):
        return [*content, {"type": "text", "text": "/no_think"}]
    return content


def _truncate_tool_result(message, limit: int):
    if _role(message) != "tool":
        return message
    content = _content(message)
    if not isinstance(content, str) or len(content) <= limit:
        return message

    marker_room = 96
    keep = max(1, limit - marker_room)
    head = keep * 2 // 3
    tail = keep - head
    omitted = len(content) - head - tail
    compact = (
        content[:head]
        + f"\n...[OpenBot omitted {omitted} chars from this tool result to limit model context]...\n"
        + content[-tail:]
    )
    return _with_content(message, compact)


def compact_model_history(messages):
    """Keep recent complete user turns for the model while preserving durable state.

    Starting at a user message avoids orphaning a tool result from the assistant tool call that
    produced it. System messages before the window stay pinned. Tool results are bounded only in
    this provider view; the full result remains in graph/transcript state.
    """
    items = list(messages)
    turn_limit = _bounded_int(
        "OPENBOT_MODEL_HISTORY_TURNS", DEFAULT_HISTORY_USER_TURNS, 1, 50
    )
    tool_limit = _bounded_int(
        "OPENBOT_TOOL_RESULT_CHARS", DEFAULT_TOOL_RESULT_CHARS, 2_000, 100_000
    )

    user_positions = [
        index for index, message in enumerate(items) if _role(message) == "user"
    ]
    if len(user_positions) > turn_limit:
        start = user_positions[-turn_limit]
        items = [
            *[
                message
                for message in items[:start]
                if _role(message) == "system"
            ],
            *items[start:],
        ]

    return [_truncate_tool_result(message, tool_limit) for message in items]


def prepare_model_messages(messages, model: str | None):
    """Build the model-only view, including Qwen's non-thinking soft switch.

    The /no_think directive is added to a copy of the latest user message and is never written back
    to LangGraph state, so it cannot leak into the visible transcript or accumulate across turns.
    """
    prepared = compact_model_history(messages)
    if not qwen3_non_thinking_enabled(model):
        return prepared

    for index in range(len(prepared) - 1, -1, -1):
        if _role(prepared[index]) != "user":
            continue
        content = _content(prepared[index])
        updated = _append_no_think(content)
        if updated is not content:
            prepared[index] = _with_content(prepared[index], updated)
        break
    return prepared
