import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.token_efficiency import (
    compact_model_history,
    prepare_model_messages,
    qwen3_max_output_tokens,
    qwen3_model,
)


def test_qwen3_detection_covers_xkiro_ids_without_matching_qwen2():
    assert qwen3_model("qwen/qwen3.6-plus")
    assert qwen3_model("qwen/qwen3-max:free")
    assert qwen3_model("openai:qwen3.6-27b")
    assert not qwen3_model("qwen2.5:1.5b")
    assert not qwen3_model("gpt-5.6-terra")


def test_no_think_is_provider_only_and_does_not_accumulate(monkeypatch):
    monkeypatch.setenv("BOT_MODEL", "qwen/qwen3.6-plus")
    source = [{"role": "user", "content": "Open example.com."}]

    first = prepare_model_messages(source, "qwen/qwen3.6-plus")
    second = prepare_model_messages(source, "qwen/qwen3.6-plus")

    assert source == [{"role": "user", "content": "Open example.com."}]
    assert first == second
    assert first[0]["content"] == "Open example.com.\n\n/no_think"
    assert first[0]["content"].count("/no_think") == 1


def test_no_think_preserves_multimodal_content(monkeypatch):
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)
    source = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this."},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
            ],
        }
    ]

    prepared = prepare_model_messages(source, "qwen/qwen3.6-plus")

    assert source[0]["content"][-1]["type"] == "image_url"
    assert prepared[0]["content"][-1] == {"type": "text", "text": "/no_think"}
    assert prepared[0]["content"][1]["type"] == "image_url"


def test_thinking_override_keeps_user_message_unchanged(monkeypatch):
    monkeypatch.setenv("OPENBOT_QWEN_THINKING", "true")
    source = [{"role": "user", "content": "Hard problem."}]

    assert prepare_model_messages(source, "qwen/qwen3.6-plus") == source


def test_history_window_keeps_system_and_complete_recent_turns(monkeypatch):
    monkeypatch.setenv("OPENBOT_MODEL_HISTORY_TURNS", "2")
    messages = [{"role": "system", "content": "standing"}]
    for i in range(4):
        messages.extend(
            [
                {"role": "user", "content": f"user-{i}"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{"id": f"call-{i}", "name": "tool"}],
                },
                {
                    "role": "tool",
                    "tool_call_id": f"call-{i}",
                    "content": f"result-{i}",
                },
                {"role": "assistant", "content": f"answer-{i}"},
            ]
        )

    compact = compact_model_history(messages)

    assert compact[0] == {"role": "system", "content": "standing"}
    assert [m["content"] for m in compact if m["role"] == "user"] == [
        "user-2",
        "user-3",
    ]
    assert any(m.get("tool_call_id") == "call-2" for m in compact)
    assert not any(m.get("tool_call_id") == "call-1" for m in compact)


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


def test_qwen_output_ceiling_is_bounded_and_overrideable(monkeypatch):
    monkeypatch.delenv("OPENBOT_QWEN_MAX_OUTPUT_TOKENS", raising=False)
    assert qwen3_max_output_tokens() == 4096

    monkeypatch.setenv("OPENBOT_QWEN_MAX_OUTPUT_TOKENS", "1024")
    assert qwen3_max_output_tokens() == 1024

    monkeypatch.setenv("OPENBOT_QWEN_MAX_OUTPUT_TOKENS", "999999")
    assert qwen3_max_output_tokens() == 32768
