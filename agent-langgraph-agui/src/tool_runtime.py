"""The current run's tools, with the same ownership contract as agent-langgraph.

Computer/UI tools finish the run for the surface to execute and resume. Only tools
marked by OpenBot's server execute here, through its signed callback. The request
context is deliberately outside graph state: assertions must never enter a
checkpoint, model message, or AG-UI state snapshot.
"""

import asyncio
import json
import os
from contextlib import aclosing
from contextvars import ContextVar
from dataclasses import dataclass, field

import httpx
from ag_ui.core import (
    Context,
    EventType,
    RunAgentInput,
    RunErrorEvent,
    Tool,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
)
from langchain_core.messages import SystemMessage, ToolMessage
from langgraph.graph import END

from .parallel_tools import ParallelToolAgent
from .token_efficiency import (
    prepare_model_messages,
    qwen3_simple_max_output_tokens,
    qwen3_stateless_fast_path_enabled,
    simple_action_tool_names,
)


@dataclass(frozen=True)
class ManagedModel:
    provider: str
    model: str
    api_key: str | None = field(default=None, repr=False)
    base_url: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None


@dataclass(frozen=True)
class RunTools:
    tools: tuple[Tool, ...] = ()
    context: tuple[Context, ...] = ()
    system_messages: tuple[SystemMessage, ...] = ()
    simple_policy: str = ""
    simple_policy_ids: frozenset[str] = frozenset()
    deployment: frozenset[str] = frozenset()
    assertion: str = field(default="", repr=False)
    managed_model: ManagedModel | None = field(default=None, repr=False)


_current: ContextVar[RunTools | None] = ContextVar("openbot_run_tools", default=None)


class ManagedModelError(ValueError):
    pass


def _managed_model(value) -> ManagedModel | None:
    """Validate the server-only per-run model envelope without ever echoing credential material."""

    if value is None:
        return None
    if not isinstance(value, dict):
        raise ManagedModelError()
    provider = value.get("provider")
    model = value.get("model")
    api_key = value.get("apiKey")
    base_url = value.get("baseUrl")
    temperature = value.get("temperature")
    max_tokens = value.get("maxTokens")

    if provider not in {"openai", "anthropic", "google"}:
        raise ManagedModelError()
    if (
        not isinstance(model, str)
        or not model.strip()
        or len(model.strip()) > 160
        or any(ch in model for ch in ("\x00", "\r", "\n"))
    ):
        raise ManagedModelError()
    if api_key is not None and (
        not isinstance(api_key, str)
        or not api_key.strip()
        or len(api_key.strip()) > 16_384
        or any(ch in api_key for ch in ("\x00", "\r", "\n"))
    ):
        raise ManagedModelError()
    if base_url is not None:
        if not isinstance(base_url, str) or len(base_url) > 2_048:
            raise ManagedModelError()
        from urllib.parse import urlsplit

        parsed = urlsplit(base_url.strip())
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ManagedModelError()
        if parsed.username is not None or parsed.password is not None:
            raise ManagedModelError()
        if provider != "openai":
            raise ManagedModelError()
        base_url = base_url.strip()
    if temperature is not None and (
        not isinstance(temperature, (int, float))
        or isinstance(temperature, bool)
        or not 0 <= float(temperature) <= 2
    ):
        raise ManagedModelError()
    if max_tokens is not None and (
        not isinstance(max_tokens, int)
        or isinstance(max_tokens, bool)
        or not 1 <= max_tokens <= 1_000_000
    ):
        raise ManagedModelError()

    return ManagedModel(
        provider=provider,
        model=model.strip(),
        api_key=api_key.strip() if isinstance(api_key, str) else None,
        base_url=base_url,
        temperature=float(temperature) if temperature is not None else None,
        max_tokens=max_tokens,
    )


# Only known presentation payloads may be omitted. Arbitrary AG-UI context can contain permission
# instructions or attached task data; an unfamiliar description is never permission to drop it.
_A2UI_SCHEMA_DESCRIPTION = (
    "A2UI Component Schema — available components for generating UI surfaces. "
    "Use these component names and properties when creating A2UI operations."
)
_PRESENTATION_CONTEXT = {
    _A2UI_SCHEMA_DESCRIPTION,
    "A2UI render tool usage guide",
    "A2UI catalog capabilities: available catalog IDs and custom component definitions the client can render.",
    "A2UI generation guidelines — protocol rules, tool arguments, path rules, data model format, and form/two-way-binding instructions.",
    "A2UI design guidelines — visual design rules, component hierarchy tips, and action handler patterns.",
}


def current_tools() -> RunTools:
    return _current.get() or RunTools()


class UnofferedToolError(ValueError):
    pass


def _value(item, name, default=None):
    return item.get(name, default) if isinstance(item, dict) else getattr(item, name, default)


def _tool_calls(message):
    return _value(message, "tool_calls", None) or _value(message, "toolCalls", None) or ()


def _call_function(call):
    function = _value(call, "function", None)
    if function is not None:
        return (
            _value(function, "name", ""),
            _value(function, "arguments", ""),
        )
    args = _value(call, "args", None)
    return _value(call, "name", ""), json.dumps(args, ensure_ascii=False) if isinstance(args, dict) else ""


def _existing_direct_call_ids(messages):
    return {
        call_id
        for message in messages or ()
        for call in _tool_calls(message)
        if isinstance((call_id := _value(call, "id", None)), str)
        and call_id.startswith("openbot-direct-")
    }


def _direct_call_events(snapshot, preexisting, emitted):
    """Fill the AG-UI stream gap for deterministic calls already persisted by LangGraph.

    ag-ui-langgraph 0.0.45 builds the final snapshot from an AIMessage returned directly by a graph
    node, but emits TOOL_CALL_* only for chat-model stream chunks. OpenBot's zero-provider compiler
    intentionally has no chat-model stream. Reuse the integration's authoritative snapshot and add
    only the three missing lifecycle events for a newly-created OpenBot call. Calls already present
    in the request (a resume) are never replayed.
    """
    if _value(snapshot, "type") != EventType.MESSAGES_SNAPSHOT:
        return ()
    events = []
    for message in _value(snapshot, "messages", ()) or ():
        if _value(message, "role") != "assistant":
            continue
        parent_id = _value(message, "id", None)
        for call in _tool_calls(message):
            call_id = _value(call, "id", None)
            if (
                not isinstance(call_id, str)
                or not call_id.startswith("openbot-direct-")
                or call_id in preexisting
                or call_id in emitted
            ):
                continue
            name, arguments = _call_function(call)
            if not isinstance(name, str) or not name or not isinstance(arguments, str):
                continue
            emitted.add(call_id)
            events.extend(
                (
                    ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=call_id,
                        tool_call_name=name,
                        parent_message_id=parent_id,
                    ),
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=call_id,
                        delta=arguments,
                    ),
                    ToolCallEndEvent(
                        type=EventType.TOOL_CALL_END,
                        tool_call_id=call_id,
                    ),
                )
            )
    return tuple(events)


class ToolAwareAgent(ParallelToolAgent):
    async def run(self, input: RunAgentInput):
        props = input.forwarded_props if isinstance(input.forwarded_props, dict) else {}
        names = props.get("openbotDeploymentTools", [])
        assertion = props.get("openbotRun", "")
        simple_policy = props.get("openbotSimpleActionPolicy", "")
        simple_policy_ids = props.get("openbotSimpleActionPolicyIds", [])
        try:
            managed_model = _managed_model(props.get("openbotManagedModel"))
        except ManagedModelError:
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message="The managed model configuration for this run is invalid.",
            )
            return
        context = RunTools(
            tools=tuple(input.tools or []),
            context=tuple(input.context or []),
            # ag-ui-langgraph 0.0.45 drops the first SystemMessage in its default merge.
            # Keep the current request's policy outside checkpoint state, just like context/tools.
            system_messages=tuple(
                SystemMessage(content=message.content, id=message.id)
                for message in input.messages or []
                if message.role == "system"
            ),
            simple_policy=simple_policy if isinstance(simple_policy, str) else "",
            simple_policy_ids=frozenset(
                message_id for message_id in simple_policy_ids if isinstance(message_id, str)
            )
            if isinstance(simple_policy_ids, list)
            else frozenset(),
            deployment=frozenset(name for name in names if isinstance(name, str))
            if isinstance(names, list)
            else frozenset(),
            assertion=assertion if isinstance(assertion, str) else "",
            managed_model=managed_model,
        )
        # The maintained endpoint clones this subclass per request. ContextVar
        # also isolates graph tasks across concurrent requests and resets on
        # cancellation. Current input.tools is authoritative; checkpoint/state
        # tools must not resurrect an offer removed by the caller.
        token = _current.set(context)
        try:
            clean_props = {
                key: value
                for key, value in props.items()
                if key
                not in {
                    "openbotRun",
                    "openbotDeploymentTools",
                    "openbotSimpleActionPolicy",
                    "openbotSimpleActionPolicyIds",
                    "openbotManagedModel",
                    "openbot_run",
                    "openbot_deployment_tools",
                    "openbot_simple_action_policy",
                    "openbot_simple_action_policy_ids",
                    "openbot_managed_model",
                }
            }
            preexisting_direct_calls = _existing_direct_call_ids(input.messages)
            emitted_direct_calls = set()
            async with aclosing(
                super().run(input.model_copy(update={"forwarded_props": clean_props}))
            ) as stream:
                async for event in stream:
                    for synthetic in _direct_call_events(
                        event, preexisting_direct_calls, emitted_direct_calls
                    ):
                        yield synthetic
                    yield event
        except UnofferedToolError:
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message="The model requested a tool that was not offered for this run.",
            )
        finally:
            _current.reset(token)


def model_messages(messages):
    """Build a bounded provider view without changing checkpoint/transcript state.

    A self-contained Qwen Computer/File command does not need A2UI rendering guidance or old chat
    turns. Only known presentation context is omitted; security and unknown context remain.
    Durable state stays complete. All other turns keep the existing context behavior.
    """
    run = current_tools()
    offered_tool_names = tuple(tool.name for tool in run.tools)
    model = run.managed_model.model if run.managed_model else os.environ.get("BOT_MODEL")
    stateless_fast_path = qwen3_stateless_fast_path_enabled(
        model, messages, offered_tool_names
    )

    context_messages = []
    seen = set()
    for entry in run.context:
        if stateless_fast_path and entry.description in _PRESENTATION_CONTEXT:
            continue
        key = (entry.description, entry.value)
        if key in seen:
            continue
        seen.add(key)
        context_messages.append(
            SystemMessage(content=f"{entry.description}\n{entry.value}")
        )

    # Current run policy wins over a checkpoint copy with the same id. Also deduplicate an
    # unchanged copy by content, so request policy is paid for exactly once on each model call.
    # For a trusted stateless fast path, only the exact server-generated policy ids may be replaced
    # by the smaller direct-action envelope. Unknown/current security messages remain untouched.
    policy_ids = {message.id for message in run.system_messages if message.id}
    policy_content = {
        message.content for message in run.system_messages if isinstance(message.content, str)
    }
    provider_policy = run.system_messages
    current_policy_ids = {message.id for message in run.system_messages if message.id}
    trusted_replacement = bool(
        run.simple_policy_ids
        and run.simple_policy_ids.issubset(current_policy_ids)
    )
    if stateless_fast_path and run.simple_policy and trusted_replacement:
        replace_ids = run.simple_policy_ids
        provider_policy = (
            SystemMessage(
                content=run.simple_policy,
                id="openbot-simple-action-policy",
            ),
            *tuple(
                message
                for message in run.system_messages
                if not message.id or message.id not in replace_ids
            ),
        )

    def current_policy_copy(message):
        role = message.get("role") if isinstance(message, dict) else message.type
        if role != "system":
            return False
        message_id = message.get("id") if isinstance(message, dict) else message.id
        content = message.get("content") if isinstance(message, dict) else message.content
        return message_id in policy_ids or (
            isinstance(content, str) and content in policy_content
        )

    history = (
        [message for message in messages if not current_policy_copy(message)]
        if run.system_messages else messages
    )
    return [
        *context_messages,
        *provider_policy,
        *prepare_model_messages(
            history,
            model,
            offered_tool_names,
        ),
    ]


def bind_tools(model, messages):
    """Bind only the tools a deterministic Qwen action can need, with a hard output backstop.

    Complex turns keep the complete tool surface and the provider's normal output budget. The fast
    path is entered only by the same conservative classifier that adds /no_think, so asking Qwen to
    analyze, debug, research or design never loses tools or reasoning room.
    """
    tools = current_tools().tools
    offered_names = tuple(tool.name for tool in tools)
    simple_limit = qwen3_simple_max_output_tokens(
        current_tools().managed_model.model
        if current_tools().managed_model
        else os.environ.get("BOT_MODEL"),
        messages,
        offered_names,
    )
    selected_names = (
        simple_action_tool_names(messages, offered_names)
        if simple_limit is not None
        else None
    )
    if selected_names is not None:
        selected = set(selected_names)
        tools = tuple(tool for tool in tools if tool.name in selected)

    runnable = model
    if tools:
        runnable = model.bind_tools(
            [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                }
                for tool in tools
            ]
        )
    if simple_limit is not None:
        runnable = runnable.bind(max_tokens=simple_limit)
    return runnable


def next_step(state):
    calls = state["messages"][-1].tool_calls
    if not calls:
        return END
    context = current_tools()
    offered = {tool.name for tool in context.tools}
    if any(call["name"] not in offered for call in calls):
        raise UnofferedToolError(
            "The model requested a tool that was not offered for this run."
        )
    # Mixed turns yield too: never invent results for a UI component or execute
    # a governed action while the surface still owns an unanswered call.
    if any(call["name"] not in context.deployment for call in calls):
        return END
    return "tools"


def _refusal_reason(response):
    """The deployment's own reason for a callback it would not run, or nothing.

    `/api/agent-tools/call` refuses with the reason under `error`, and the model can only tell the
    person why, or correct a malformed call, if it is told. Read here rather than inside the
    callback's error handler, so a body that is not JSON costs the reason and not the refusal.
    """
    try:
        body = response.json()
    except ValueError:
        return ""
    error = body.get("error") if isinstance(body, dict) else None
    return f" {error.strip()}" if isinstance(error, str) and error.strip() else ""


async def _call_tool(call, context):
    async def result():
        token = (os.environ.get("AGENT_TOOL_TOKEN") or "").strip()
        if not token:
            return (
                "Refused. This Bot has no credential for calling tools through its deployment.",
                True,
            )
        if not context.assertion:
            return (
                "Refused. This run carried no signed statement of which Bot and person it is for.",
                True,
            )
        url = (
            os.environ.get("OPENBOT_TOOL_URL")
            or "http://127.0.0.1:3001/api/agent-tools/call"
        )
        try:
            # Redirects must never carry this deployment's credential elsewhere.
            async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
                response = await client.post(
                    url,
                    headers={"x-openbot-agent-token": token},
                    json={
                        "name": call["name"],
                        "args": call["args"],
                        "run": context.assertion,
                    },
                )
            if not response.is_success:
                return (
                    f"Refused. Tool callback returned HTTP {response.status_code}."
                    f"{_refusal_reason(response)}",
                    True,
                )
            body = response.json()
            if not isinstance(body, dict) or not isinstance(body.get("text"), str):
                return "The tool callback returned no readable result.", True
            return body["text"], False
        except (httpx.HTTPError, ValueError):
            # Exception strings can contain URLs. Report the boundary, never its
            # credential-bearing request or response. CancelledError propagates.
            return "The tool callback could not be completed.", True

    text, failed = await result()
    return ToolMessage(
        content=text,
        tool_call_id=call["id"],
        name=call["name"],
        status="error" if failed else "success",
    )


async def execute_tools(state):
    context = current_tools()
    # Recheck ownership at the execution boundary as well as the graph edge.
    if next_step(state) != "tools":
        raise ValueError(
            "This turn must return to the surface before tools can execute."
        )
    results = await asyncio.gather(
        *[_call_tool(call, context) for call in state["messages"][-1].tool_calls]
    )
    return {"messages": results}
