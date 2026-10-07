"""Adaptive provider-view token controls.

Savings must not make the Bot less capable on hard work. These helpers therefore remove repetition
and runaway context first, while keeping reasoning enabled for normal analysis. Only short,
deterministic Computer/File operations get Qwen's non-thinking fast path.

Everything here changes only the provider view. LangGraph state and the OpenBot/Intelligence
transcript stay complete.
"""

import json
import os
import re

DEFAULT_MODEL_CONTEXT_CHARS = 96_000
DEFAULT_TOOL_RESULT_CHARS = 24_000
DEFAULT_QWEN_SIMPLE_MAX_OUTPUT_TOKENS = 2_048
_QWEN3 = re.compile(r"(^|[/:._-])qwen3([/:._-]|$)", re.IGNORECASE)
_TRUE = {"1", "true", "yes", "on", "enabled", "always"}
_FALSE = {"0", "false", "no", "off", "disabled", "never"}

# Deliberately narrow. A false negative costs a few tokens; a false positive could remove useful
# reasoning. These are direct, observable Computer/File operations rather than analysis tasks.
_SIMPLE_ACTIONS = (
    "open ",
    "open the ",
    "navigate",
    "visit ",
    "go to ",
    "click ",
    "press ",
    "type ",
    "fill ",
    "read file",
    "read the file",
    "list file",
    "write file",
    "create file",
    "save file",
    "screenshot",
    "screen shot",
    "take a screenshot",
    "mở ",
    "truy cập",
    "vào trang",
    "bấm ",
    "nhấn ",
    "điền ",
    "gõ ",
    "đọc file",
    "đọc tệp",
    "liệt kê file",
    "liệt kê tệp",
    "tạo file",
    "tạo tệp",
    "ghi file",
    "ghi tệp",
    "lưu file",
    "lưu tệp",
    "chụp màn hình",
)

_COMPLEX_SIGNALS = (
    "analyze",
    "analysis",
    "reason",
    "explain",
    "compare",
    "evaluate",
    "research",
    "investigate",
    "debug",
    "refactor",
    "architect",
    "design a",
    "plan ",
    "strategy",
    "optimize",
    "security review",
    "why ",
    "how does",
    "phân tích",
    "suy luận",
    "giải thích",
    "so sánh",
    "đánh giá",
    "nghiên cứu",
    "điều tra",
    "kiểm tra kỹ",
    "sửa lỗi",
    "tối ưu",
    "thiết kế",
    "lập kế hoạch",
    "chiến lược",
    "tại sao",
    "như thế nào",
)


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


def qwen3_max_output_tokens() -> int | None:
    """Return only an explicitly configured Qwen output ceiling.

    OpenBot does not impose a default ceiling: doing so can reduce the model's ability on legitimate
    long or difficult work. Automatic savings happen elsewhere by removing redundant context and by
    using Qwen's non-thinking mode only on narrow deterministic Computer/File operations.
    """
    raw = (os.environ.get("OPENBOT_QWEN_MAX_OUTPUT_TOKENS") or "").strip()
    if not raw:
        return None
    return _bounded_int(
        "OPENBOT_QWEN_MAX_OUTPUT_TOKENS",
        4_096,
        256,
        32_768,
    )


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


def _has_non_text_payload(content) -> bool:
    if not isinstance(content, list):
        return False
    for part in content:
        if isinstance(part, str):
            continue
        if not isinstance(part, dict):
            return True
        # A plain text part is safe. Images/files/audio remain reasoning-enabled.
        if set(part).issubset({"type", "text"}) and isinstance(part.get("text"), str):
            continue
        return True
    return False


def _latest_user_message(messages):
    for message in reversed(list(messages)):
        if _role(message) == "user":
            return message
    return None


def _latest_user_text(messages) -> str | None:
    message = _latest_user_message(messages)
    if message is None:
        return None
    content = _content(message)
    if _has_non_text_payload(content):
        return None
    text = " ".join(_text_parts(content)).strip().lower()
    return text or None


def simple_operational_turn(messages, offered_tool_names=()) -> bool:
    """Conservatively recognise a direct Computer/File action.

    This is intentionally biased toward returning False. Saving fewer tokens is preferable to
    disabling reasoning on a request that might benefit from it.
    """
    names = tuple(name for name in offered_tool_names if isinstance(name, str))
    if not names:
        return False
    if not any(
        name.startswith(("computer_", "browser_", "file_", "workspace_", "screen_"))
        for name in names
    ):
        return False

    text = _latest_user_text(messages)
    if not text or len(text) > 600:
        return False
    if any(signal in text for signal in _COMPLEX_SIGNALS):
        return False
    return any(action in text for action in _SIMPLE_ACTIONS)


def qwen3_simple_max_output_tokens(
    model: str | None,
    messages,
    offered_tool_names=(),
) -> int | None:
    """Bound only deterministic Qwen Computer/File turns.

    Compatible gateways do not consistently honor Qwen's /no_think hint. A small completion
    ceiling is therefore the hard backstop against a trivial click/file action spending tens of
    thousands of hidden reasoning tokens. Complex turns are untouched. Explicit thinking=on
    also disables this fast-path ceiling.
    """
    if not qwen3_non_thinking_enabled(model, messages, offered_tool_names):
        return None
    simple_limit = _bounded_int(
        "OPENBOT_QWEN_SIMPLE_MAX_OUTPUT_TOKENS",
        DEFAULT_QWEN_SIMPLE_MAX_OUTPUT_TOKENS,
        256,
        8_192,
    )
    global_limit = qwen3_max_output_tokens()
    return min(simple_limit, global_limit) if global_limit is not None else simple_limit


def simple_action_tool_names(messages, offered_tool_names=()) -> tuple[str, ...] | None:
    """Return a small, capability-preserving tool set for an obvious direct action.

    The model still receives all tools for analysis/research/debug/design work. This only narrows
    deterministic Computer/File requests where the user's intent identifies the required tool.
    Companion tools stay available when an action commonly needs a snapshot, page read, secret, or
    human handoff.
    """
    offered = tuple(name for name in offered_tool_names if isinstance(name, str))
    if not simple_operational_turn(messages, offered):
        return None

    text = _latest_user_text(messages)
    if not text:
        return None

    groups = (
        (
            ("chụp màn hình", "take a screenshot", "screenshot", "screen shot"),
            ("computer_screenshot",),
            ("computer_screenshot",),
        ),
        (
            ("tạo file", "tạo tệp", "ghi file", "ghi tệp", "lưu file", "lưu tệp",
             "create file", "write file", "save file"),
            ("computer_write_file",),
            ("computer_write_file", "computer_read_file", "computer_list_files"),
        ),
        (
            ("đọc file", "đọc tệp", "read file", "read the file"),
            ("computer_read_file",),
            ("computer_read_file", "computer_list_files"),
        ),
        (
            ("liệt kê file", "liệt kê tệp", "list file"),
            ("computer_list_files",),
            ("computer_list_files", "computer_read_file"),
        ),
        (
            ("bấm ", "nhấn ", "click ", "press "),
            ("computer_snapshot", "computer_click"),
            ("computer_snapshot", "computer_click", "computer_read", "computer_request_help"),
        ),
        (
            ("điền ", "gõ ", "type ", "fill "),
            ("computer_snapshot", "computer_type"),
            (
                "computer_snapshot",
                "computer_type",
                "computer_click",
                "computer_read",
                "computer_request_secret",
                "computer_request_help",
            ),
        ),
        (
            ("mở ", "truy cập", "vào trang", "open ", "open the ", "navigate", "visit ", "go to "),
            ("computer_navigate",),
            (
                "computer_navigate",
                "computer_read",
                "computer_snapshot",
                "computer_screenshot",
                "computer_request_help",
            ),
        ),
    )

    offered_set = set(offered)
    for signals, required, useful in groups:
        if not any(signal in text for signal in signals):
            continue
        if not set(required).issubset(offered_set):
            return None
        wanted = set(useful)
        return tuple(name for name in offered if name in wanted)
    return None

def qwen3_non_thinking_enabled(
    model: str | None,
    messages,
    offered_tool_names=(),
) -> bool:
    if not qwen3_model(model):
        return False
    mode = (os.environ.get("OPENBOT_QWEN_THINKING") or "").strip().lower()
    if mode in _TRUE:
        return False
    if mode in _FALSE:
        return True
    return simple_operational_turn(messages, offered_tool_names)


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


def _message_chars(message) -> int:
    try:
        if isinstance(message, dict):
            value = message
        else:
            dumper = getattr(message, "model_dump", None)
            value = dumper(mode="json") if callable(dumper) else {
                "role": _role(message),
                "content": _content(message),
            }
        return len(json.dumps(value, ensure_ascii=False, default=str))
    except (TypeError, ValueError):
        return len(str(_content(message) or "")) + 64


def compact_model_history(messages):
    """Preserve normal histories exactly; trim only after the provider view is genuinely large.

    Individual giant tool outputs are bounded first. If the remaining conversation is still over
    the character budget, OpenBot removes the oldest COMPLETE user turns until it fits. Leading
    system messages and the newest turn are always retained. Durable history is untouched.
    """
    tool_limit = _bounded_int(
        "OPENBOT_TOOL_RESULT_CHARS", DEFAULT_TOOL_RESULT_CHARS, 2_000, 200_000
    )
    budget = _bounded_int(
        "OPENBOT_MODEL_CONTEXT_CHARS",
        DEFAULT_MODEL_CONTEXT_CHARS,
        16_000,
        1_000_000,
    )
    items = [_truncate_tool_result(message, tool_limit) for message in messages]
    if sum(_message_chars(message) for message in items) <= budget:
        return items

    user_positions = [
        index for index, message in enumerate(items) if _role(message) == "user"
    ]
    if len(user_positions) <= 1:
        return items

    leading_system = []
    first_user = user_positions[0]
    for message in items[:first_user]:
        if _role(message) == "system":
            leading_system.append(message)

    # Never drop the latest user turn. Walk from oldest to newest and choose the largest retained
    # suffix that fits. Starting at a user boundary avoids orphaning a tool result.
    for start in user_positions[1:]:
        candidate = [*leading_system, *items[start:]]
        if sum(_message_chars(message) for message in candidate) <= budget:
            return candidate

    return [*leading_system, *items[user_positions[-1] :]]


def prepare_model_messages(messages, model: str | None, offered_tool_names=()):
    """Build the model-only view and use /no_think only for safe, direct Qwen tool turns."""
    prepared = compact_model_history(messages)
    if not qwen3_non_thinking_enabled(model, prepared, offered_tool_names):
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
