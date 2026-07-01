"""Shared model configuration helpers — read by all agents at startup."""
import os


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


def _subscription_model() -> str | None:
    """Return the DEFAULT_MODEL string when the Claude subscription backend is
    active, else ``None``.

    Enabled by ``DEFAULT_MODEL=claude-cli`` (optionally ``claude-cli:<model>``,
    e.g. ``claude-cli:sonnet``) or by a truthy ``CLAUDE_SUBSCRIPTION`` env var.
    """
    model = os.getenv("DEFAULT_MODEL", "")
    if model == "claude-cli" or model.startswith("claude-cli:"):
        return model
    if _truthy(os.getenv("CLAUDE_SUBSCRIPTION")):
        return model
    return None


def get_default_model(fallback: str = "gpt-5.4"):
    """Return the configured default model for standard agents."""
    sub = _subscription_model()
    if sub is not None:
        from claude_subscription_model import ClaudeSubscriptionModel  # noqa: PLC0415

        cli_model = (
            (sub.split(":", 1)[1] or None) if sub.startswith("claude-cli:") else None
        )
        return ClaudeSubscriptionModel(model=cli_model)
    model = os.getenv("DEFAULT_MODEL", fallback)
    return _resolve(model)


def is_openai_provider() -> bool:
    """Return True when the configured provider is OpenAI (not LiteLLM).

    OpenAI model IDs never contain a slash (e.g. 'gpt-5.4', 'o3').
    Any 'provider/model' string (e.g. 'anthropic/claude-sonnet-4-6',
    'litellm/gemini/gemini-3-flash') is treated as a LiteLLM-routed model.
    The Claude subscription backend is NOT OpenAI, so reasoning-effort and other
    OpenAI-only settings stay off.
    """
    if _subscription_model() is not None:
        return False
    return "/" not in os.getenv("DEFAULT_MODEL", "")


def _resolve(model: str):
    """Route 'provider/model' strings through LitellmModel.

    Handles both explicit 'litellm/<model>' and bare 'provider/model' forms.
    OpenAI model IDs contain no slash, so they pass through unchanged.
    """
    if "/" not in model:
        return model
    bare = model[len("litellm/"):] if model.startswith("litellm/") else model
    try:
        from agency_swarm import LitellmModel  # noqa: PLC0415
        return LitellmModel(model=bare)
    except ImportError:
        return model
