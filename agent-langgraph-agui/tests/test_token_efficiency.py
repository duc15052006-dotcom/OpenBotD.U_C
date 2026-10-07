import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.token_efficiency import (
    compact_model_history,
    compact_stateless_simple_history,
    prepare_model_messages,
    qwen3_max_output_tokens,
    qwen3_model,
    qwen3_simple_max_output_tokens,
    qwen3_stateless_fast_path_enabled,
    simple_action_tool_names,
    simple_operational_turn,
    stateless_simple_action_turn,
)


COMPUTER_TOOLS = ["computer_navigate", "computer_snapshot", "computer_read_file"]
FULL_COMPUTER_TOOLS = [
    "computer_navigate",
    "computer_read",
    "computer_screenshot",
    "computer_snapshot",
    "computer_type",
    "computer_click",
    "computer_request_secret",
    "computer_request_help",
    "computer_list_files",
    "computer_read_file",
    "computer_write_file",
]


def test_qwen3_detection_covers_xkiro_ids_without_matching_qwen2():
    assert qwen3_model("qwen/qwen3.6-plus")
    assert qwen3_model("qwen/qwen3-max:free")
    assert qwen3_model("openai:qwen3.6-27b")
    assert not qwen3_model("qwen2.5:1.5b")
    assert not qwen3_model("gpt-5.6-terra")


def test_simple_computer_turn_gets_no_think_without_mutating_history(monkeypatch):
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)
    source = [{"role": "user", "content": "Open example.com."}]

    first = prepare_model_messages(
        source, "qwen/qwen3.6-plus", COMPUTER_TOOLS
    )
    second = prepare_model_messages(
        source, "qwen/qwen3.6-plus", COMPUTER_TOOLS
    )

    assert source == [{"role": "user", "content": "Open example.com."}]
    assert first == second
    assert first[0]["content"] == "Open example.com.\n\n/no_think"
    assert first[0]["content"].count("/no_think") == 1


def test_complex_request_keeps_qwen_reasoning_even_when_computer_tools_exist(monkeypatch):
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)
    source = [
        {
            "role": "user",
            "content": "Analyze why this website workflow is failing and design the safest fix.",
        }
    ]

    assert (
        prepare_model_messages(source, "qwen/qwen3.6-plus", COMPUTER_TOOLS)
        == source
    )


def test_multimodal_turn_keeps_reasoning_and_payload(monkeypatch):
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)
    source = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this screenshot carefully."},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
            ],
        }
    ]

    prepared = prepare_model_messages(
        source, "qwen/qwen3.6-plus", COMPUTER_TOOLS
    )

    assert prepared == source
    assert prepared[0]["content"][1]["type"] == "image_url"


def test_explicit_thinking_override_keeps_simple_user_message_unchanged(monkeypatch):
    monkeypatch.setenv("OPENBOT_QWEN_THINKING", "true")
    source = [{"role": "user", "content": "Open example.com."}]

    assert (
        prepare_model_messages(source, "qwen/qwen3.6-plus", COMPUTER_TOOLS)
        == source
    )


def test_simple_classifier_requires_direct_computer_action():
    assert simple_operational_turn(
        [{"role": "user", "content": "Chụp màn hình hiện tại."}],
        ["computer_screenshot"],
    )
    assert not simple_operational_turn(
        [{"role": "user", "content": "Chụp màn hình hiện tại."}],
        ["computer_snapshot"],
    )
    assert not simple_operational_turn(
        [{"role": "user", "content": "Phân tích kỹ lỗi này rồi đề xuất cách sửa."}],
        ["computer_snapshot"],
    )
    assert not simple_operational_turn(
        [{"role": "user", "content": "Open example.com."}],
        ["granted_lookup"],
    )



def test_simple_qwen_turn_gets_small_hard_output_budget(monkeypatch):
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)
    monkeypatch.delenv("OPENBOT_QWEN_SIMPLE_MAX_OUTPUT_TOKENS", raising=False)
    messages = [{"role": "user", "content": "Tạo file notes.txt với nội dung hello."}]

    assert (
        qwen3_simple_max_output_tokens(
            "qwen/qwen3.6-plus", messages, FULL_COMPUTER_TOOLS
        )
        == 2048
    )
    assert (
        qwen3_simple_max_output_tokens(
            "qwen/qwen3.6-plus",
            [{"role": "user", "content": "Phân tích kiến trúc này thật kỹ."}],
            FULL_COMPUTER_TOOLS,
        )
        is None
    )


def test_simple_qwen_budget_respects_explicit_thinking_and_overrides(monkeypatch):
    messages = [{"role": "user", "content": "Create file notes.txt with hello."}]
    monkeypatch.setenv("OPENBOT_QWEN_THINKING", "on")
    assert (
        qwen3_simple_max_output_tokens(
            "qwen/qwen3.6-plus", messages, FULL_COMPUTER_TOOLS
        )
        is None
    )

    monkeypatch.setenv("OPENBOT_QWEN_THINKING", "off")
    monkeypatch.setenv("OPENBOT_QWEN_SIMPLE_MAX_OUTPUT_TOKENS", "1024")
    assert (
        qwen3_simple_max_output_tokens(
            "qwen/qwen3.6-plus", messages, FULL_COMPUTER_TOOLS
        )
        == 1024
    )


def test_self_contained_file_action_narrows_to_exact_write_tool():
    selected = simple_action_tool_names(
        [{"role": "user", "content": "Tạo file /workspace/notes.txt với nội dung hello."}],
        FULL_COMPUTER_TOOLS,
    )

    assert selected == ("computer_write_file",)


def test_simple_screenshot_narrows_to_real_screenshot_tool():
    selected = simple_action_tool_names(
        [{"role": "user", "content": "Hãy chụp màn hình hiện tại."}],
        FULL_COMPUTER_TOOLS,
    )

    assert selected == ("computer_screenshot",)


def test_complex_turn_never_narrows_tools():
    assert (
        simple_action_tool_names(
            [
                {
                    "role": "user",
                    "content": "Phân tích lỗi website này rồi thiết kế cách sửa an toàn.",
                }
            ],
            FULL_COMPUTER_TOOLS,
        )
        is None
    )

def test_stateless_fast_path_requires_self_contained_target(monkeypatch):
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)
    explicit = [{"role": "user", "content": "Tạo file /workspace/a.txt với nội dung hello."}]
    relative = [{"role": "user", "content": "Tạo file đó với nội dung vừa nói."}]

    assert stateless_simple_action_turn(explicit, FULL_COMPUTER_TOOLS)
    assert qwen3_stateless_fast_path_enabled(
        "qwen/qwen3.6-plus", explicit, FULL_COMPUTER_TOOLS
    )
    assert not stateless_simple_action_turn(relative, FULL_COMPUTER_TOOLS)
    assert not qwen3_stateless_fast_path_enabled(
        "qwen/qwen3.6-plus", relative, FULL_COMPUTER_TOOLS
    )


def test_stateless_history_keeps_system_and_current_tool_chain_only():
    source = [
        {"role": "system", "content": "standing policy"},
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "Tạo file /workspace/a.txt với nội dung hello."},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "call-1"}]},
        {"role": "tool", "tool_call_id": "call-1", "content": "written"},
    ]

    compact = compact_stateless_simple_history(source)

    assert compact[0] == {"role": "system", "content": "standing policy"}
    assert all(message.get("content") != "old question" for message in compact)
    assert all(message.get("content") != "old answer" for message in compact)
    assert compact[-1]["content"] == "written"


def test_prepare_stateless_qwen_drops_old_turns_but_complex_qwen_keeps_them(monkeypatch):
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)
    source = [
        {"role": "system", "content": "standing policy"},
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "Tạo file /workspace/a.txt với nội dung hello."},
    ]

    fast = prepare_model_messages(source, "qwen/qwen3.6-plus", FULL_COMPUTER_TOOLS)
    assert not any(message.get("content") == "old question" for message in fast)
    assert fast[-1]["content"].endswith("/no_think")

    complex_source = [
        {"role": "system", "content": "standing policy"},
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "Phân tích kiến trúc hiện tại và đề xuất cách tối ưu."},
    ]
    assert prepare_model_messages(
        complex_source, "qwen/qwen3.6-plus", FULL_COMPUTER_TOOLS
    ) == complex_source

def test_normal_history_is_not_trimmed_below_large_context_budget(monkeypatch):
    monkeypatch.delenv("OPENBOT_MODEL_CONTEXT_CHARS", raising=False)
    source = [
        {"role": "system", "content": "standing"},
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "answer one"},
        {"role": "user", "content": "second"},
        {"role": "assistant", "content": "answer two"},
    ]

    assert compact_model_history(source) == source


def test_large_history_trims_only_old_complete_turns(monkeypatch):
    monkeypatch.setenv("OPENBOT_MODEL_CONTEXT_CHARS", "16000")
    monkeypatch.setenv("OPENBOT_TOOL_RESULT_CHARS", "100000")
    messages = [{"role": "system", "content": "standing"}]
    for i in range(3):
        messages.extend(
            [
                {"role": "user", "content": f"user-{i}-" + ("U" * 6000)},
                {"role": "assistant", "content": f"answer-{i}-" + ("A" * 200)},
            ]
        )

    compact = compact_model_history(messages)
    users = [m["content"] for m in compact if m["role"] == "user"]

    assert compact[0] == {"role": "system", "content": "standing"}
    assert any(text.startswith("user-2-") for text in users)
    assert not any(text.startswith("user-0-") for text in users)
    # The retained suffix always starts at a user boundary rather than an orphaned assistant/tool.
    assert compact[1]["role"] == "user"


def test_large_tool_result_is_bounded_only_in_provider_view(monkeypatch):
    monkeypatch.setenv("OPENBOT_TOOL_RESULT_CHARS", "2000")
    original = "A" * 6000
    source = [
        {"role": "user", "content": "Read it."},
        {"role": "tool", "tool_call_id": "call-1", "content": original},
    ]

    compact = compact_model_history(source)

    assert source[1]["content"] == original
    assert len(compact[1]["content"]) < len(original)
    assert "OpenBot omitted" in compact[1]["content"]
    assert compact[1]["content"].startswith("A" * 100)
    assert compact[1]["content"].endswith("A" * 100)


def test_qwen_output_ceiling_is_opt_in_only(monkeypatch):
    monkeypatch.delenv("OPENBOT_QWEN_MAX_OUTPUT_TOKENS", raising=False)

    assert qwen3_max_output_tokens() is None

    monkeypatch.setenv("OPENBOT_QWEN_MAX_OUTPUT_TOKENS", "1024")
    assert qwen3_max_output_tokens() == 1024

    monkeypatch.setenv("OPENBOT_QWEN_MAX_OUTPUT_TOKENS", "999999")
    assert qwen3_max_output_tokens() == 32768


@pytest.mark.parametrize("prompt", [
    "làm lại file đó",
    "Tạo file /workspace/a.txt với nội dung vừa nói.",
    "Write file /workspace/a.txt with the previous content.",
    "Create file /workspace/a.txt with the final result.",
    "Tạo file /workspace/a.txt với nội dung báo cáo cũ.",
    "Create file /workspace/a.py with code for a complete application.",
    "Chụp màn hình trang đó.",
    "Liệt kê file trong thư mục đó.",
    "Mở https://example.com rồi tìm thông tin và viết báo cáo.",
    "Hãy chụp màn hình hiện tại và đọc file /workspace/a.txt.",
    "Click Save then fix the problem.",
    "Read file /workspace/a.txt and summarize the implications.",
])
def test_dependent_or_multiple_actions_keep_history_reasoning_and_tools(monkeypatch, prompt):
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)
    history = [
        {"role": "user", "content": "Earlier task data."},
        {"role": "assistant", "content": "Earlier answer."},
        {"role": "user", "content": prompt},
    ]
    assert not stateless_simple_action_turn(history, FULL_COMPUTER_TOOLS)
    assert prepare_model_messages(history, "qwen/qwen3.6-plus:free", FULL_COMPUTER_TOOLS) == history
    assert qwen3_simple_max_output_tokens("qwen/qwen3.6-plus:free", history, FULL_COMPUTER_TOOLS) is None
    assert simple_action_tool_names(history, FULL_COMPUTER_TOOLS) is None


@pytest.mark.parametrize(("prompt", "expected"), [
    ("Hãy tạo file `/workspace/token-test-next.txt` với nội dung `hello`.", "computer_write_file"),
    ("Đọc file /workspace/a.txt.", "computer_read_file"),
    ("List files in /workspace.", "computer_list_files"),
    ("Hãy chụp màn hình Computer hiện tại và trả về ảnh chụp.", "computer_screenshot"),
    ("Open https://example.com.", "computer_navigate"),
])
def test_self_contained_commands_identify_only_the_required_action(prompt, expected):
    history = [{"role": "user", "content": prompt}]
    assert stateless_simple_action_turn(history, FULL_COMPUTER_TOOLS)
    selected = simple_action_tool_names(history, FULL_COMPUTER_TOOLS)
    assert expected in selected
    assert set(selected) == ({expected, "computer_request_help"} if expected == "computer_navigate" else {expected})


@pytest.mark.parametrize("problem", ["orphan", "incomplete", "error", "refusal", "different_tool"])
def test_unsafe_resume_never_gets_a_stateless_view_or_simple_cap(monkeypatch, problem):
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)
    history = [
        {"role": "user", "content": "Earlier prompt."},
        {"role": "assistant", "content": "Earlier answer."},
        {"role": "user", "content": "Tạo file /workspace/a.txt với nội dung hello."},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "call-write", "name": "computer_write_file", "args": {"path": "a.txt", "content": "hello"}}
        ]},
        {"role": "tool", "tool_call_id": "call-write", "content": "written"},
    ]
    if problem == "orphan":
        history[-1]["tool_call_id"] = "earlier-call"
    elif problem == "incomplete":
        history.pop()
    elif problem == "error":
        history[-1]["status"] = "error"
    elif problem == "refusal":
        history[-1]["content"] = "Refused. The deployment policy denied this write."
    else:
        history[-2]["tool_calls"][0]["name"] = "computer_read_file"
    assert prepare_model_messages(history, "qwen/qwen3.6-plus:free", FULL_COMPUTER_TOOLS) == history
    assert qwen3_simple_max_output_tokens("qwen/qwen3.6-plus:free", history, FULL_COMPUTER_TOOLS) is None


def test_stateless_large_history_preserves_intervening_security_and_developer_policy(monkeypatch):
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)
    history = [
        {"role": "system", "content": "Default-deny; never bypass CAPTCHA/MFA/login."},
        {"role": "user", "content": "Old content " + "x" * 100_000},
        {"role": "developer", "content": "Only the sandbox workspace is writable."},
        {"role": "system", "content": "Never expose credentials."},
        {"role": "user", "content": "Create file /workspace/a.txt with hello."},
    ]
    prepared = prepare_model_messages(history, "qwen/qwen3.6-plus:free", FULL_COMPUTER_TOOLS)
    assert prepared[:3] == [history[0], history[2], history[3]]
    assert len(history[1]["content"]) > 100_000
    assert history[-1]["content"] == "Create file /workspace/a.txt with hello."


def test_attachment_on_an_explicit_action_disables_fast_path(monkeypatch):
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)
    history = [{"role": "user", "content": [
        {"type": "text", "text": "Create file /workspace/a.txt with hello."},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
    ]}]
    assert prepare_model_messages(history, "qwen/qwen3.6-plus:free", FULL_COMPUTER_TOOLS) == history
    assert qwen3_simple_max_output_tokens("qwen/qwen3.6-plus:free", history, FULL_COMPUTER_TOOLS) is None
