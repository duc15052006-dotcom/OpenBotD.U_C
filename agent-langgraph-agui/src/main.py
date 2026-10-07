"""LangGraph as a Bot, through the AG-UI integration rather than by hand.

OpenBot already ships `agent-langgraph`, which speaks AG-UI itself because it predates the rule
against writing adapters. This is the same framework served through `ag-ui-langgraph`, which is the
package the AG-UI project maintains, so the protocol stops being ours to keep working.
"""

import os
from pathlib import Path
from uuid import uuid4

from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from langchain.chat_models import init_chat_model
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import START, MessagesState, StateGraph

from .direct_actions import (
    completed_literal_qwen_write,
    direct_write_acknowledgement,
    fresh_literal_qwen_write,
)
from .tool_runtime import (
    ToolAwareAgent,
    bind_tools,
    current_tools,
    execute_tools,
    model_messages,
    next_step,
)
from .token_efficiency import qwen3_max_output_tokens, qwen3_model

TOKEN_HEADER = "x-openbot-agent-token"

# Provider names supported by LangChain's public init_chat_model contract. A colon in an opaque
# compatible model ID (for example qwen2.5:1.5b) is not a provider separator.
MODEL_PROVIDERS = {
    "anthropic",
    "anthropic_bedrock",
    "azure_ai",
    "azure_openai",
    "baseten",
    "bedrock",
    "bedrock_converse",
    "cohere",
    "deepseek",
    "fireworks",
    "google_anthropic_vertex",
    "google_genai",
    "google_vertexai",
    "groq",
    "huggingface",
    "ibm",
    "langsmith",
    "litellm",
    "meta",
    "mistralai",
    "nvidia",
    "ollama",
    "openai",
    "openrouter",
    "perplexity",
    "together",
    "upstage",
    "xai",
}

OPENBOT_PROVIDER_ALIASES = {
    "google": "google_genai",
}


def _normalize_openai_base_url():
    base_url = os.environ.get("OPENAI_BASE_URL")
    if base_url is None:
        return
    base_url = base_url.strip()
    if base_url:
        os.environ["OPENAI_BASE_URL"] = base_url
    else:
        os.environ.pop("OPENAI_BASE_URL", None)


def _google_genai_kwargs(provider: str):
    if provider != "google_genai":
        return {}
    base_url = (os.environ.get("GOOGLE_GENERATIVE_AI_BASE_URL") or "").strip()
    if not base_url:
        return {}
    return {"base_url": base_url}


def _resolve_provider(provider: str):
    return OPENBOT_PROVIDER_ALIASES.get(provider, provider)


def _model_kwargs(provider: str, model: str):
    kwargs = _google_genai_kwargs(provider)
    # Never lower Qwen's output/reasoning budget by default. A deployment owner may opt into a hard
    # ceiling explicitly, but OpenBot's automatic savings come from removing redundant context and
    # using /no_think only for narrow deterministic tool turns.
    if provider == "openai" and qwen3_model(model):
        max_tokens = qwen3_max_output_tokens()
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
    return kwargs


def _chatgpt_auth_file(store: str) -> Path:
    path = Path(store)
    if not path.exists():
        raise FileNotFoundError(
            f"CHATGPT_AUTH_FILE points to a missing file: {path}"
        )
    if path.is_dir():
        raise IsADirectoryError(
            f"CHATGPT_AUTH_FILE must point to a file, not a directory: {path}"
        )
    if not os.access(path, os.R_OK):
        raise PermissionError(f"CHATGPT_AUTH_FILE is not readable: {path}")
    with path.open("rb"):
        pass
    return path


def _model():
    """The model this Bot thinks with, chosen by which credential the deployment gave it.

    A SIGNED-IN CHATGPT PLAN IS NOT AN API KEY, and this is the only place that difference shows up.
    A plan token is a bearer for `chatgpt.com/backend-api/codex`, and `langchain-openai` pins that
    address and refuses a caller-supplied one on purpose, so pointing `OPENAI_BASE_URL` at it and
    passing the token as a key does not work and is not meant to. The Codex chat model is the
    supported way in, and it is selected by the presence of the token rather than by another
    setting, so nothing can say "plan" while holding a key.

    A recognized `provider:model` choice keeps its provider. Otherwise the model is an opaque ID
    and the selected provider is passed separately, including when that ID contains a colon.
    """
    configured_model = os.environ.get("BOT_MODEL")
    model = (configured_model or "gpt-4o-mini").strip()
    store = (os.environ.get("CHATGPT_AUTH_FILE") or "").strip()
    if store:
        store_path = _chatgpt_auth_file(store)
        # Private and experimental, both deliberately. `langchain-openai` exports no public Codex
        # model and warns in the module that this one is unofficial. That is a maintenance cost we
        # took knowingly rather than a reason to withhold the plan, because a subscription someone
        # already pays for is the whole point of offering it on the model screen.
        from langchain_openai.chat_models.codex import _ChatOpenAICodex

        from .chatgpt_store import ChatGptTokenStore

        # THE STORE FILE, NOT A BARE TOKEN. An access token expires within the hour and cannot be
        # renewed; the store holds the refresh token, and this provider renews from it. A Bot given
        # only the access token works until lunchtime and then reports an auth error nobody can
        # explain.
        return _ChatOpenAICodex(
            model=model,
            token_provider=ChatGptTokenStore(path=store_path),
        )

    _normalize_openai_base_url()
    provider = (os.environ.get("BOT_PROVIDER") or "").strip() or "openai"
    provider = _resolve_provider(provider)
    if not configured_model:
        model = {
            "anthropic": "claude-sonnet-4-5",
            "google_genai": "gemini-2.5-flash",
        }.get(provider, model)
    prefix, separator, _ = model.partition(":")
    if separator and prefix in MODEL_PROVIDERS:
        return init_chat_model(model, **_model_kwargs(prefix, model))
    return init_chat_model(
        model,
        model_provider=provider,
        **_model_kwargs(provider, model),
    )


def _direct_write_schema_supported() -> bool:
    """Fail closed unless the offered surface tool accepts the exact compiled fields."""

    for tool in current_tools().tools:
        if tool.name != "computer_write_file":
            continue
        parameters = tool.parameters
        if not isinstance(parameters, dict):
            return False
        properties = parameters.get("properties")
        return isinstance(properties, dict) and {"path", "content"}.issubset(properties)
    return False


async def answer(state: MessagesState):
    state_messages = state["messages"]
    offered_names = tuple(tool.name for tool in current_tools().tools)
    model_name = os.environ.get("BOT_MODEL")

    # A literal, self-contained workspace write has no model decision left to make. Compile it
    # straight into the already-governed surface tool call. This removes provider tokens entirely
    # for the canonical token smoke test while keeping the durable transcript/tool protocol intact.
    # Anything even slightly ambiguous, unsupported by the current schema, or reasoning-dependent
    # falls through to the normal model path.
    if _direct_write_schema_supported():
        completed = completed_literal_qwen_write(
            state_messages, model_name, offered_names
        )
        if completed is not None:
            # Keep this import lazy. Repository compose probes intentionally stub the harness's
            # provider modules without installing the Python runtime dependency set.
            from langchain_core.messages import AIMessage

            return {
                "messages": [
                    AIMessage(content=direct_write_acknowledgement(state_messages))
                ]
            }

        direct = fresh_literal_qwen_write(state_messages, model_name, offered_names)
        if direct is not None:
            from langchain_core.messages import AIMessage

            return {
                "messages": [
                    AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": direct["name"],
                                "args": direct["args"],
                                "id": f"openbot-direct-{uuid4()}",
                                "type": "tool_call",
                            }
                        ],
                    )
                ]
            }

    messages = model_messages(state_messages)
    return {"messages": [await bind_tools(_model(), messages).ainvoke(messages)]}


builder = StateGraph(MessagesState)
builder.add_node("answer", answer)
builder.add_edge(START, "answer")
builder.add_node("tools", execute_tools)
builder.add_conditional_edges("answer", next_step)
builder.add_edge("tools", "answer")
# A checkpointer, because the AG-UI integration resumes a thread by id and LangGraph refuses to
# without one. In memory rather than in Postgres: OpenBot's database is where a conversation lives,
# and two stores remembering the same thread is how they come to disagree.
graph = builder.compile(checkpointer=MemorySaver())

app = FastAPI()


@app.middleware("http")
async def refuse_without_the_server_token(request: Request, call_next):
    if request.url.path != "/health":
        expected = (os.environ.get("MANAGED_AGENT_TOKEN") or "").strip()
        offered = (request.headers.get(TOKEN_HEADER) or "").strip()
        if not expected or offered != expected:
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "harness": "langgraph"}


add_langgraph_fastapi_endpoint(
    app=app,
    agent=ToolAwareAgent(
        name="openbot", graph=graph, config={"recursion_limit": 25}
    ),
    path="/",
)
