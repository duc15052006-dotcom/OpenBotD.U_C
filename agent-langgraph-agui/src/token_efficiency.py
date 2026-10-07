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
DEFAULT_QWEN_SIMPLE_MAX_OUTPUT_TOKENS = 1_024
_QWEN3 = re.compile(r"(^|[/:._-])qwen3([/:._-]|$)", re.IGNORECASE)
_TRUE = {"1", "true", "yes", "on", "enabled", "always"}
_FALSE = {"0", "false", "no", "off", "disabled", "never"}
_TARGET = r"(?:`[^`\n]+`|\"[^\"\n]+\"|'[^'\n]+'|[^\s`\"';,]+)"
_PREFIX = r"(?:(?:please|hãy|vui lòng)\s+)?"
_DEPENDENT = re.compile(
    r"\b(?:again|previous|above|earlier|same|that|those|it|them|"
    r"then|after|existing|discussed|this|these|prior|vừa|trước|như|giống|cũ|rồi|sau đó|làm lại|đó|ấy|"
    r"đính kèm|attachment)\b",
    re.IGNORECASE,
)
_WRITE_ACTION = re.compile(
    _PREFIX + r"(?:tạo|ghi|lưu|create|write|save)\s+(?:the\s+)?(?:file|tệp)\s+"
    + r"(?P<target>" + _TARGET + r")\s+"
    + r"(?:với nội dung|with(?: the)?(?: content)?|containing)\s+(?P<content>.+)",
    re.IGNORECASE,
)
_READ_ACTION = re.compile(
    _PREFIX + r"(?:đọc|read)\s+(?:the\s+)?(?:file|tệp)\s+"
    + r"(?P<target>" + _TARGET + r")[.!]?",
    re.IGNORECASE,
)
_LIST_ACTION = re.compile(
    _PREFIX + r"(?:liệt kê (?:file|tệp)|list (?:the )?files?)"
    + r"(?: (?:trong|in)(?: the)? (?P<target>" + _TARGET + r"))?[.!]?",
    re.IGNORECASE,
)
_SCREENSHOT_ACTION = re.compile(
    _PREFIX + r"(?:chụp màn hình(?: computer)?(?: hiện tại)?(?: và trả về ảnh(?: chụp)?)?"
    + r"|(?:take (?:a )?)?(?:screenshot|screen shot)"
    + r"(?: (?:of )?(?:the )?(?:current )?(?:computer|screen))?)[.!]?",
    re.IGNORECASE,
)
_NAVIGATE_ACTION = re.compile(
    _PREFIX + r"(?:mở|truy cập|vào trang|open(?: the)?|navigate(?: to)?|visit|go to)\s+"
    + r"(?P<target>" + _TARGET + r")[.!]?",
    re.IGNORECASE,
)
_DIRECT_INPUT_ACTION = re.compile(
    _PREFIX + r"(?:click|press|bấm|nhấn|type|fill|gõ|điền)\s+"
    + r"(?:`[^`\n]{1,120}`|\"[^\"\n]{1,120}\"|'[^'\n]{1,120}'|[\w-]+(?: [\w-]+){0,2})[.!]?",
    re.IGNORECASE,
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
    # bind_tools sees the prepared view too. Ignore only the trailing hint we append below.
    text = re.sub(r"\s*/no_think\s*$", "", text)
    return text or None


def _field(message, name, default=None):
    return message.get(name, default) if isinstance(message, dict) else getattr(message, name, default)


def _current_tool_chain_safe(messages, expected_tool=None) -> bool:
    """No stateless view across an incomplete, cross-turn, failed or multimodal tool chain."""
    items = list(messages)
    latest = next((i for i in range(len(items) - 1, -1, -1) if _role(items[i]) == "user"), None)
    if latest is None:
        return False
    if _field(items[latest], "attachments"):
        return False
    pending = set()
    seen = set()
    for message in items[latest + 1:]:
        if _has_non_text_payload(_content(message)):
            return False
        role = _role(message)
        if role == "assistant":
            if pending:
                return False
            for call in _field(message, "tool_calls", ()) or ():
                call_id = call.get("id")
                if not isinstance(call_id, str) or not call_id or call_id in seen:
                    return False
                name = call.get("name") or (call.get("function") or {}).get("name")
                if expected_tool and name != expected_tool:
                    return False
                seen.add(call_id)
                pending.add(call_id)
        elif role == "tool":
            call_id = _field(message, "tool_call_id") or _field(message, "toolCallId")
            if call_id not in pending or _field(message, "status") == "error":
                return False
            # Surface results have no status field. A refusal/error needs full recovery tools.
            text = " ".join(_text_parts(_content(message))).lower()
            if re.search(r"\b(?:refused|error|failed|denied|stale|not found|no file|lỗi|từ chối)\b", text):
                return False
            pending.remove(call_id)
        elif role not in {"system", "developer"}:
            return False
    return not pending


def _explicit_file_target(target: str) -> bool:
    target = target.strip("`\"'").rstrip(".! ")
    return bool(target and "://" not in target and (
        "/" in target or "\\" in target or re.fullmatch(r"[\w.-]+\.[a-z0-9]{1,12}", target)
    ))


def _self_contained_action(text: str) -> str | None:
    """Full command matches, rather than an action/filename anywhere in an arbitrary request."""
    if _DEPENDENT.search(text):
        return None
    if _SCREENSHOT_ACTION.fullmatch(text):
        return "computer_screenshot"
    if match := _WRITE_ACTION.fullmatch(text):
        content = match["content"].rstrip(".! ")
        # A path alone does not establish the content. Unquoted generation/derived-content
        # requests need reasoning/history; quoted text is an explicit literal to write.
        literal = len(content) >= 2 and content[0] in "`\"'" and content[-1] == content[0]
        derived = re.search(
            r"\b(?:from|using|according|generate|build|implement|code|script|program|"
            r"theo|như|dựa|từ|tạo|viết|mã|chương trình)\b", content
        )
        plain_literal = bool(re.fullmatch(r"[\w-]{1,80}", content)) and not derived
        if _explicit_file_target(match["target"]) and len(content) <= 180 and (literal or plain_literal):
            return "computer_write_file"
    if match := _READ_ACTION.fullmatch(text):
        if _explicit_file_target(match["target"]):
            return "computer_read_file"
    if match := _LIST_ACTION.fullmatch(text):
        target = match["target"]
        if target is None or target.rstrip(".!") == "workspace" or _explicit_file_target(target):
            return "computer_list_files"
    if match := _NAVIGATE_ACTION.fullmatch(text):
        target = match["target"].strip("`\"'").rstrip(".!")
        if re.fullmatch(r"(?:https?://|www\.)[^\s]+|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::[0-9]+)?(?:/[^\s]*)?", target):
            return "computer_navigate"
    return None


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
    action = _self_contained_action(text)
    if action and action not in names:
        return False
    if not _current_tool_chain_safe(messages, action):
        return False
    return bool(action or (
        not _DEPENDENT.search(text) and _DIRECT_INPUT_ACTION.fullmatch(text)
    ))


def stateless_simple_action_turn(messages, offered_tool_names=()) -> bool:
    """Recognise only self-contained actions that do not need earlier conversation context.

    This is deliberately stricter than simple_operational_turn. A click such as "press it" or a
    file request such as "save that" may be simple, but it depends on prior turns and must retain
    them. Screenshot/list requests are self-contained by nature; file and navigation requests need
    an explicit target.
    """
    offered = tuple(name for name in offered_tool_names if isinstance(name, str))
    if not simple_operational_turn(messages, offered):
        return False
    text = _latest_user_text(messages)
    if not text:
        return False

    return _self_contained_action(text) in offered


def qwen3_stateless_fast_path_enabled(
    model: str | None,
    messages,
    offered_tool_names=(),
) -> bool:
    """Whether Qwen may receive the minimal provider view for a self-contained action."""
    if not qwen3_model(model):
        return False
    mode = (os.environ.get("OPENBOT_QWEN_THINKING") or "").strip().lower()
    if mode in _TRUE:
        return False
    return stateless_simple_action_turn(messages, offered_tool_names)

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
    action = _self_contained_action(text)
    offered_set = set(offered)
    if action:
        if action not in offered_set:
            return None
        wanted = {action}
        # Even opening an explicit URL can encounter a sign-in/MFA/CAPTCHA wall.
        if action == "computer_navigate":
            wanted.add("computer_request_help")
    elif re.match(_PREFIX + r"(?:click|press|bấm|nhấn)\s", text):
        if not {"computer_snapshot", "computer_click"}.issubset(offered_set):
            return None
        wanted = {"computer_snapshot", "computer_click", "computer_read", "computer_request_help"}
    else:
        if not {"computer_snapshot", "computer_type"}.issubset(offered_set):
            return None
        wanted = {
            "computer_snapshot", "computer_type", "computer_click", "computer_read",
            "computer_request_secret", "computer_request_help",
        }
    return tuple(name for name in offered if name in wanted)


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


def compact_stateless_simple_history(messages):
    """Keep system policy plus only the current self-contained user turn.

    Surface tool results that resume the same turn live after that latest user message and are kept.
    Older conversation turns are omitted only from the provider view; durable LangGraph/OpenBot
    history remains untouched.
    """
    items = list(messages)
    user_positions = [
        index for index, message in enumerate(items) if _role(message) == "user"
    ]
    if not user_positions:
        return items
    latest_user = user_positions[-1]
    leading_system = [
        message for message in items[:latest_user] if _role(message) in {"system", "developer"}
    ]
    return [*leading_system, *items[latest_user:]]

def compact_model_history(messages):
    """Preserve normal histories exactly; trim only after the provider view is genuinely large.

    Individual giant tool outputs are bounded first. If the remaining conversation is still over
    the character budget, OpenBot removes the oldest COMPLETE user turns until it fits. All
    system/developer instructions and the newest turn remain. Durable history is untouched.
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

    # Never drop the latest user turn. Walk from oldest to newest and choose the largest retained
    # suffix that fits. Preserve every system/developer instruction before the retained boundary,
    # including policies inserted between user turns.
    for start in user_positions[1:]:
        policies = [message for message in items[:start] if _role(message) in {"system", "developer"}]
        candidate = [*policies, *items[start:]]
        if sum(_message_chars(message) for message in candidate) <= budget:
            return candidate
    return candidate


def prepare_model_messages(messages, model: str | None, offered_tool_names=()):
    """Build the provider-only view without weakening complex or context-dependent turns."""
    # Select before generic compaction: never let that pass erase an intervening policy or
    # evidence that this turn's tool result belongs to an older assistant call.
    prepared = (
        compact_stateless_simple_history(messages)
        if qwen3_stateless_fast_path_enabled(model, messages, offered_tool_names)
        else list(messages)
    )
    prepared = compact_model_history(prepared)

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
