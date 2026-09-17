# Per-agent model configuration

This branch adds per-agent model/provider settings without storing model API keys in agent JSON.

Design constraints:
- Existing agents keep using the deployment model and credential when no per-agent setting exists.
- Per-agent secrets remain in the encrypted credential vault (`kind: model`).
- Agent configuration stores only non-secret model metadata plus a credential id reference.
- Built-in agents consume the per-agent model at runtime; remote AG-UI/Mastra agents keep owning their own model configuration at their endpoint.
- Provider support follows CopilotKit runtime v2 model identifiers (`openai`, `anthropic`, `google`).
- OpenAI-compatible base URLs are treated separately and are not silently applied to Anthropic/Google.
