import logging
import os
import time
from threading import Lock
from typing import Any, Callable

from langchain.chat_models import init_chat_model

logger = logging.getLogger("copilot.agent.llm_manager")

class LLMFallbackManager:
    """
    Manages API key rotation and fallback for multiple LLM providers.
    Automatically handles rate limits, quotas, and timeouts by temporarily
    banning failed keys and retrying with the next available key.
    """
    
    def __init__(self):
        self.lock = Lock()
        self.cooldowns: dict[str, float] = {}  # api_key -> timestamp when cooldown ends
        
        # Prioritize Groq first, then Gemini
        self.providers = [
            {
                "name": "Groq",
                "provider": "groq",
                "model": "openai/gpt-oss-120b",
                "env_prefix": "GROQ_API_KEY",
            },
            {
                "name": "Gemini",
                "provider": "google_genai",
                "model": "gemini-2.5-flash-lite",
                "env_prefix": "GEMINI_API_KEY",
            }
        ]
        
        self.keys_by_provider: dict[str, list[tuple[str, str]]] = {}
        for p in self.providers:
            keys = []
            prefix = p["env_prefix"]
            for k, v in os.environ.items():
                if k.startswith(prefix) and v.strip():
                    keys.append((k, v.strip()))
            
            # Sort lexicographically so GEMINI_API_KEY comes before GEMINI_API_KEY_2
            keys.sort(key=lambda x: x[0])
            self.keys_by_provider[p["name"]] = keys

    def _is_rate_limit(self, exc: Exception) -> bool:
        s = str(exc).lower()
        return "429" in s or "rate limit" in s or "too many requests" in s
        
    def _is_quota(self, exc: Exception) -> bool:
        s = str(exc).lower()
        return "quota" in s or "402" in s or "billing" in s or "exhausted" in s
        
    def _is_timeout(self, exc: Exception) -> bool:
        s = str(exc).lower()
        return "timeout" in s or "deadline" in s or "timed out" in s

    def invoke_with_fallback(self, emit: Callable, action: Callable[[Any], Any]) -> tuple[Any, str]:
        """
        Executes `action(llm)` with automatic fallback.
        `action` must accept an initialized `llm` and return the result.
        Returns `(result, final_model_name)`.
        """
        last_error = None
        
        for provider_idx, provider_conf in enumerate(self.providers):
            provider_name = provider_conf["name"]
            model_name = provider_conf["model"]
            keys = self.keys_by_provider[provider_name]
            
            if not keys:
                continue
                
            for key_idx, (env_key_name, api_key) in enumerate(keys):
                with self.lock:
                    unban_time = self.cooldowns.get(api_key, 0)
                    if time.time() < unban_time:
                        continue  # Still in cooldown
                        
                friendly_name = f"{provider_name} Key {key_idx + 1}"
                
                try:
                    llm = init_chat_model(
                        model=model_name,
                        model_provider=provider_conf["provider"],
                        temperature=0.0,
                        api_key=api_key
                    )
                except Exception as e:
                    logger.warning("Failed to initialize %s: %s", friendly_name, e)
                    continue
                    
                try:
                    # Attempt the actual API call
                    result = action(llm)
                    return result, model_name
                except Exception as e:
                    last_error = e
                    logger.warning("%s encountered an error: %s", friendly_name, e)
                    
                    # Determine cooldown duration based on error type
                    if self._is_quota(e):
                        cooldown_secs = 86400  # 24 hours
                        reason = "quota exceeded"
                    elif self._is_rate_limit(e):
                        cooldown_secs = 60  # 1 minute
                        reason = "rate limited"
                    elif self._is_timeout(e):
                        cooldown_secs = 30  # 30 seconds
                        reason = "timed out"
                    else:
                        cooldown_secs = 120  # 2 minutes for unknown/auth errors
                        reason = "API error"
                        
                    with self.lock:
                        self.cooldowns[api_key] = time.time() + cooldown_secs
                        
                    # Emit toast notification
                    has_more_keys = (key_idx + 1 < len(keys))
                    if has_more_keys:
                        msg = f"{friendly_name} {reason}. Trying another key..."
                    else:
                        has_more_providers = (provider_idx + 1 < len(self.providers))
                        if has_more_providers:
                            next_provider = self.providers[provider_idx + 1]["name"]
                            msg = f"All {provider_name} keys failed. Trying {next_provider}..."
                        else:
                            msg = "All configured API providers are currently unavailable."
                            
                    emit("fallback", msg, toast=True)
                    
        # If we fall through the loops, all keys failed or were on cooldown
        error_msg = "All configured API providers are currently unavailable or on cooldown."
        logger.error(error_msg)
        if last_error:
            raise Exception(error_msg) from last_error
        raise Exception(error_msg)

