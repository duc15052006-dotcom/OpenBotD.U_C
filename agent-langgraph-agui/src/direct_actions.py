"""Zero-provider routing for deterministic direct actions.

Only commands already accepted by the conservative Qwen stateless classifier may enter here.
The first optimization is deliberately limited to literal writes inside /workspace. Complex,
ambiguous, multimodal, history-dependent and non-Qwen turns continue through the model unchanged.
"""

import re
from pathlib import PurePosixPath

from .token_efficiency import (
    _content,
    _field,
    _latest_user_text,
    _role,
    _self_contained_action,
    _text_parts,
    _WRITE_ACTION,
    qwen3_stateless_fast_path_enabled,
)

_FAILURE = re.compile(
    r"\b(?:refused|error|failed|denied|stale|not found|no file|lỗi|từ chối)\b",
    re.IGNORECASE,
)


def _latest_user_index(messages) -> int | None:
    items = list(messages)
    for index in range(len(items) - 1, -1, -1):
        if _role(items[index]) == "user":
            return index
    return None


def _unquote_literal(value: str) -> str:
    value = value.strip()
    # The sentence-ending punctuation may sit outside a quoted/backticked literal.
    if len(value) >= 2 and value[-1] in ".!" and value[-2] in "`\"'":
        value = value[:-1].rstrip()
    if len(value) >= 2 and value[0] in "`\"'" and value[-1] == value[0]:
        return value[1:-1]
    return value.rstrip(".! ")


def _workspace_path(value: str) -> str | None:
    path = _unquote_literal(value)
    parsed = PurePosixPath(path)
    if (
        not path.startswith("/workspace/")
        or ".." in parsed.parts
        or path.endswith("/")
    ):
        return None
    return path


def literal_qwen_write(messages, model: str | None, offered_tool_names=()):
    """Return exact write args only for a self-contained literal Qwen workspace write."""

    offered = tuple(name for name in offered_tool_names if isinstance(name, str))
    if "computer_write_file" not in offered:
        return None
    if not qwen3_stateless_fast_path_enabled(model, messages, offered):
        return None
    if _self_contained_action(_latest_user_text(messages) or "") != "computer_write_file":
        return None

    items = list(messages)
    latest = _latest_user_index(items)
    if latest is None:
        return None
    raw = _content(items[latest])
    if not isinstance(raw, str):
        return None
    match = _WRITE_ACTION.fullmatch(raw.strip())
    if not match:
        return None

    path = _workspace_path(match["target"])
    if path is None:
        return None
    content = _unquote_literal(match["content"])
    if not content or len(content) > 180:
        return None
    return {"name": "computer_write_file", "args": {"path": path, "content": content}}


def fresh_literal_qwen_write(messages, model: str | None, offered_tool_names=()):
    """Compile only before a model/tool answer exists for the latest user turn."""

    directive = literal_qwen_write(messages, model, offered_tool_names)
    if directive is None:
        return None
    items = list(messages)
    latest = _latest_user_index(items)
    if latest is None:
        return None
    if any(_role(message) in {"assistant", "tool"} for message in items[latest + 1 :]):
        return None
    return directive


def completed_literal_qwen_write(messages, model: str | None, offered_tool_names=()):
    """Recognise a successful completed direct-write chain so resume also needs no provider call."""

    directive = literal_qwen_write(messages, model, offered_tool_names)
    if directive is None:
        return None

    items = list(messages)
    latest = _latest_user_index(items)
    if latest is None:
        return None
    tail = [
        message
        for message in items[latest + 1 :]
        if _role(message) not in {"system", "developer"}
    ]
    if len(tail) != 2 or [_role(message) for message in tail] != ["assistant", "tool"]:
        return None

    calls = _field(tail[0], "tool_calls", ()) or ()
    if len(calls) != 1:
        return None
    call = calls[0]
    name = call.get("name") or (call.get("function") or {}).get("name")
    args = call.get("args")
    if args is None:
        function = call.get("function") or {}
        args = function.get("arguments")
    if name != directive["name"] or args != directive["args"]:
        return None

    call_id = call.get("id")
    result_id = _field(tail[1], "tool_call_id") or _field(tail[1], "toolCallId")
    if not isinstance(call_id, str) or call_id != result_id:
        return None
    if _field(tail[1], "status") == "error":
        return None
    result_text = " ".join(_text_parts(_content(tail[1])))
    if _FAILURE.search(result_text):
        return None
    return directive


def direct_write_acknowledgement(messages) -> str:
    """Small terminal response; the actual tool result remains in durable history."""

    text = _latest_user_text(messages) or ""
    return "Đã hoàn tất." if any(word in text for word in ("hãy ", "tạo ", "với nội dung")) else "Done."
