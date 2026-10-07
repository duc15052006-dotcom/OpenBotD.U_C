import sys
from pathlib import Path

import pytest
from ag_ui.core import Tool
from langchain_core.messages import AIMessage, ToolMessage

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import main
from src.direct_actions import fresh_literal_qwen_write
from src.tool_runtime import RunTools, _current


MODEL = "qwen/qwen3.6-plus:free"


def write_tool(parameters=None):
    return Tool(
        name="computer_write_file",
        description="Write a literal file inside the governed workspace.",
        parameters=parameters
        or {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    )


class FakeRunnable:
    def __init__(self):
        self.calls = []

    async def ainvoke(self, messages):
        self.calls.append(messages)
        return AIMessage(content="provider fallback")


@pytest.mark.asyncio
async def test_literal_qwen_write_skips_provider_and_preserves_exact_literal(
    monkeypatch,
):
    monkeypatch.setenv("BOT_MODEL", MODEL)
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)

    def provider_must_not_be_built():
        raise AssertionError("literal write must not construct or call the provider")

    monkeypatch.setattr(main, "_model", provider_must_not_be_built)
    token = _current.set(RunTools(tools=(write_tool(),)))
    try:
        result = await main.answer(
            {
                "messages": [
                    {"role": "user", "content": "OLD-UNRELATED-" + "X" * 80_000},
                    {"role": "assistant", "content": "old answer"},
                    {
                        "role": "user",
                        "content": (
                            "Hãy tạo file `/workspace/token-test-next.txt` "
                            "với nội dung `Hello.WORLD!`."
                        ),
                    },
                ]
            }
        )
    finally:
        _current.reset(token)

    message = result["messages"][0]
    assert isinstance(message, AIMessage)
    assert message.content == ""
    assert len(message.tool_calls) == 1
    assert message.tool_calls[0]["name"] == "computer_write_file"
    assert message.tool_calls[0]["args"] == {
        "path": "/workspace/token-test-next.txt",
        "content": "Hello.WORLD!",
    }
    assert message.tool_calls[0]["id"].startswith("openbot-direct-")


@pytest.mark.asyncio
async def test_literal_qwen_write_resume_also_skips_provider(monkeypatch):
    monkeypatch.setenv("BOT_MODEL", MODEL)
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)

    def provider_must_not_be_built():
        raise AssertionError("successful direct-write resume must not call the provider")

    monkeypatch.setattr(main, "_model", provider_must_not_be_built)
    request = "Hãy tạo file `/workspace/token-test-next.txt` với nội dung `hello`."
    call = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "computer_write_file",
                "args": {
                    "path": "/workspace/token-test-next.txt",
                    "content": "hello",
                },
                "id": "openbot-direct-proof",
                "type": "tool_call",
            }
        ],
    )
    result_message = ToolMessage(
        content="Wrote hello to /workspace/token-test-next.txt.",
        tool_call_id="openbot-direct-proof",
    )
    token = _current.set(RunTools(tools=(write_tool(),)))
    try:
        result = await main.answer(
            {
                "messages": [
                    {"role": "user", "content": "OLD-UNRELATED-" + "X" * 80_000},
                    {"role": "assistant", "content": "old answer"},
                    {"role": "user", "content": request},
                    call,
                    result_message,
                ]
            }
        )
    finally:
        _current.reset(token)

    terminal = result["messages"][0]
    assert isinstance(terminal, AIMessage)
    assert terminal.content == "Đã hoàn tất."
    assert terminal.tool_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("model", "prompt", "thinking", "parameters"),
    [
        (MODEL, "làm lại file đó", "", None),
        (
            MODEL,
            "Hãy tạo file `/workspace/a.txt` với nội dung `hello`.",
            "on",
            None,
        ),
        (
            "gpt-ci",
            "Hãy tạo file `/workspace/a.txt` với nội dung `hello`.",
            "",
            None,
        ),
        (
            MODEL,
            "Hãy tạo file `/outside/a.txt` với nội dung `hello`.",
            "",
            None,
        ),
        (
            MODEL,
            "Hãy tạo file `/workspace/a.txt` với nội dung `hello`.",
            "",
            {
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
            },
        ),
    ],
)
async def test_unsafe_or_nonmatching_turns_fall_back_to_provider(
    monkeypatch, model, prompt, thinking, parameters
):
    monkeypatch.setenv("BOT_MODEL", model)
    if thinking:
        monkeypatch.setenv("OPENBOT_QWEN_THINKING", thinking)
    else:
        monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)

    runnable = FakeRunnable()
    monkeypatch.setattr(main, "_model", lambda: object())
    monkeypatch.setattr(main, "bind_tools", lambda _model, _messages: runnable)

    tool = write_tool(parameters) if parameters is not None else write_tool()
    token = _current.set(RunTools(tools=(tool,)))
    try:
        result = await main.answer({"messages": [{"role": "user", "content": prompt}]})
    finally:
        _current.reset(token)

    assert result["messages"][0].content == "provider fallback"
    assert len(runnable.calls) == 1


def test_direct_parser_preserves_case_and_rejects_path_traversal(monkeypatch):
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)
    offered = ("computer_write_file",)

    assert fresh_literal_qwen_write(
        [
            {
                "role": "user",
                "content": "Create file `/workspace/A.txt` with `MiXeD.Case!`.",
            }
        ],
        MODEL,
        offered,
    ) == {
        "name": "computer_write_file",
        "args": {"path": "/workspace/A.txt", "content": "MiXeD.Case!"},
    }
    assert (
        fresh_literal_qwen_write(
            [
                {
                    "role": "user",
                    "content": "Create file `/workspace/../escape.txt` with `hello`.",
                }
            ],
            MODEL,
            offered,
        )
        is None
    )
