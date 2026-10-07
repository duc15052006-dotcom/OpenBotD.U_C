import json
import sys
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import main


def request_body(*, thread_id=None, messages=None):
    return {
        "threadId": thread_id or str(uuid4()),
        "runId": str(uuid4()),
        "messages": messages
        or [
            {
                "id": "write-request",
                "role": "user",
                "content": (
                    "Hãy tạo file `/workspace/token-test-next.txt` "
                    "với nội dung `hello`."
                ),
            }
        ],
        "tools": [
            {
                "name": "computer_write_file",
                "description": "Write a literal file inside the governed workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["path", "content"],
                },
            }
        ],
        "context": [],
        "state": {},
        "forwardedProps": {},
    }


async def run(body):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/",
            json=body,
            headers={"x-openbot-agent-token": "direct-proof-server-token"},
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert not [event for event in events if event["type"] == "RUN_ERROR"], events
    assert events[-1]["type"] == "RUN_FINISHED"
    return events


def snapshot(events):
    return next(
        event["messages"]
        for event in reversed(events)
        if event["type"] == "MESSAGES_SNAPSHOT"
    )


@pytest.mark.asyncio
async def test_agui_literal_write_and_resume_need_no_provider_credentials(
    monkeypatch,
):
    monkeypatch.setenv("BOT_MODEL", "qwen/qwen3.6-plus:free")
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "direct-proof-server-token")
    monkeypatch.delenv("OPENBOT_QWEN_THINKING", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("CHATGPT_AUTH_FILE", raising=False)

    first_body = request_body(
        messages=[
            {
                "id": "old-user",
                "role": "user",
                "content": "OLD-UNRELATED-" + "X" * 80_000,
            },
            {
                "id": "old-assistant",
                "role": "assistant",
                "content": "Old unrelated answer.",
            },
            {
                "id": "write-request",
                "role": "user",
                "content": (
                    "Hãy tạo file `/workspace/token-test-next.txt` "
                    "với nội dung `hello`."
                ),
            },
        ]
    )
    first = await run(first_body)

    starts = [
        event
        for event in first
        if event["type"] == "TOOL_CALL_START"
        and event["toolCallName"] == "computer_write_file"
    ]
    assert len(starts) == 1

    history = snapshot(first)
    assistant = next(
        message
        for message in reversed(history)
        if message["role"] == "assistant" and message.get("toolCalls")
    )
    tool_call = assistant["toolCalls"][0]
    history.append(
        {
            "id": "surface-result",
            "role": "tool",
            "toolCallId": tool_call["id"],
            "content": "Wrote hello to /workspace/token-test-next.txt.",
        }
    )

    second = await run(
        request_body(thread_id=first_body["threadId"], messages=history)
    )
    final_history = snapshot(second)
    assert final_history[-1]["role"] == "assistant"
    assert final_history[-1]["content"] == "Đã hoàn tất."
    assert any(
        message.get("id") == "old-user" and "OLD-UNRELATED" in message.get("content", "")
        for message in final_history
    )
