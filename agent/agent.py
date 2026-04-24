import json
import time
import os
import re
from google import genai
from dotenv import load_dotenv

from logger import log
from models import Conversation, ToolDefinition, ToolCall, AgentResponse
from tools import tool_registry
from convergence import InformationGainTracker, CONVERGENCE_NUDGE

load_dotenv()


def initialize_config() -> dict:
    config = {
        "GEMINI_API_KEY": os.getenv("GEMINI_API_KEY"),
        "GEMINI_MODEL": os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite-preview"),
        "THROTTLE_RATE": int(os.getenv("THROTTLE_RATE", 2))
    }
    if not config["GEMINI_API_KEY"]:
        raise ValueError("GEMINI_API_KEY is not set in the environment variables.")
    return config


def initialize_genai_client(config: dict) -> genai.Client:
    return genai.Client(api_key=config["GEMINI_API_KEY"])


def build_system_prompt(tools: list[ToolDefinition]) -> str:
    tool_descriptions = "\n".join(
        f'- {t.name}({", ".join(t.parameters.keys())}):  {t.description}' for t in tools)
    return f"""You are a deep research assistant. You have access to the following tools:

{tool_descriptions}

You may use as many tools as needed to thoroughly answer the user's question. Use ONE tool per response. After receiving a tool result, decide whether you need more information from a different source or whether you have enough to provide a comprehensive answer.

When you need to use a tool, respond with ONLY a JSON object in this exact format:
{{"tool": "tool_name", "arguments": {{"param_name": "value"}}}}

When you are ready to answer, respond with a well-structured plain text answer that synthesizes all your findings. Do NOT wrap your final answer in JSON."""


def parse_response(response_text: str) -> AgentResponse:
    cleaned = response_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```.*\n|```$", "", cleaned, flags=re.DOTALL).strip()

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict) and "tool" in parsed:
            return AgentResponse(
                content=None,
                tool_call=ToolCall(
                    name=parsed["tool"],
                    arguments=parsed.get("arguments", {})
                )
            )
    except (json.JSONDecodeError, KeyError):
        pass

    if cleaned.startswith("{"):
        brace_depth = 0
        end = -1
        for i, ch in enumerate(cleaned):
            if ch == "{":
                brace_depth += 1
            elif ch == "}":
                brace_depth -= 1
                if brace_depth == 0:
                    end = i + 1
                    break
        if end > 0:
            try:
                parsed = json.loads(cleaned[:end])
                if isinstance(parsed, dict) and "tool" in parsed:
                    log("WARN", "LLM returned tool call with trailing text — extracting tool call.")
                    return AgentResponse(
                        content=None,
                        tool_call=ToolCall(
                            name=parsed["tool"],
                            arguments=parsed.get("arguments", {})
                        )
                    )
            except (json.JSONDecodeError, KeyError):
                pass

    return AgentResponse(content=response_text, tool_call=None)


def call_llm(prompt: str, client: genai.Client, config: dict, max_retries: int = 3) -> AgentResponse:
    for attempt in range(max_retries):
        try:
            wait = config["THROTTLE_RATE"] * (2 ** attempt)
            if attempt > 0:
                log("INFO", f"Retry {attempt + 1}/{max_retries}: Waiting {wait}s...")
            time.sleep(wait)

            response_text = client.models.generate_content(
                model=config["GEMINI_MODEL"],
                contents=prompt
            ).text
            return parse_response(response_text)
        except Exception as e:
            log("ERROR", f"Attempt {attempt + 1} failed: {e}")
            if attempt == max_retries - 1:
                raise
    raise RuntimeError("LLM call failed after maximum retries.")


def agent_loop(user_input: str, client: genai.Client, tools: list[ToolDefinition], config: dict):
    conversation = Conversation(messages=[])
    tracker = InformationGainTracker()

    system_prompt = build_system_prompt(tools)
    log("SYSTEM", system_prompt)
    conversation.add(role="system", content=system_prompt)
    conversation.add(role="assistant", content="Understood. I will use the tools when needed and respond with plain text when I have the answer.")
    conversation.add(role="user", content=user_input)

    log("USER", user_input)

    for iteration in range(5):
        log("INFO", f"Step {iteration + 1}: Thinking...")
        prompt = conversation.to_prompt()
        response: AgentResponse = call_llm(json.dumps(prompt), client, config)

        if response.is_final:
            log("ANSWER", response.content)
            break

        if response.tool_call:
            tool_def = next((t for t in tools if t.name == response.tool_call.name), None)
            if not tool_def:
                log("ERROR", f"Tool '{response.tool_call.name}' not found in registry.")
                conversation.add(role="assistant", content=f"Error: Tool '{response.tool_call.name}' not recognized.")
                continue

            log("TOOL", f"Calling '{tool_def.name}'", data=response.tool_call.arguments)
            result = tool_def.function(**response.tool_call.arguments)
            log("TOOL_RESULT", f"'{tool_def.name}' returned", data={"output": result})

            conversation.add("agent", json.dumps({"tool": tool_def.name, "arguments": response.tool_call.arguments}))
            conversation.add("tool_result", result)

            tracker.measure(tool_def.name, result)
            if tracker.converged:
                log("INFO", f"Convergence detected — nudging model to synthesize. Gains: {tracker.summary['gains']}")
                conversation.add("system", CONVERGENCE_NUDGE)
    else:
        log("WARN", "Agent hit max iterations without a final answer.")


def agent_loop_stream(user_input: str, client: genai.Client, tools: list[ToolDefinition], config: dict):
    """Generator version of agent_loop that yields event dicts for SSE streaming."""
    conversation = Conversation(messages=[])
    tracker = InformationGainTracker()

    system_prompt = build_system_prompt(tools)
    log("SYSTEM", system_prompt)
    conversation.add(role="system", content=system_prompt)
    conversation.add(role="assistant", content="Understood. I will use the tools when needed and respond with plain text when I have the answer.")
    conversation.add(role="user", content=user_input)

    log("USER", user_input)
    yield {"type": "user", "content": user_input}

    for iteration in range(5):
        log("INFO", f"Step {iteration + 1}: Thinking...")
        yield {"type": "thinking", "step": iteration + 1}
        prompt = conversation.to_prompt()
        response: AgentResponse = call_llm(json.dumps(prompt), client, config)

        if response.is_final:
            log("ANSWER", response.content)
            yield {"type": "answer", "content": response.content}
            return

        if response.tool_call:
            tool_def = next((t for t in tools if t.name == response.tool_call.name), None)
            if not tool_def:
                log("ERROR", f"Tool '{response.tool_call.name}' not found.")
                yield {"type": "error", "content": f"Tool '{response.tool_call.name}' not found."}
                continue

            log("TOOL", f"Calling '{tool_def.name}'", data=response.tool_call.arguments)
            yield {"type": "tool_call", "tool": tool_def.name, "arguments": response.tool_call.arguments}
            result = tool_def.function(**response.tool_call.arguments)
            log("TOOL_RESULT", f"'{tool_def.name}' returned", data={"output": result})
            yield {"type": "tool_result", "tool": tool_def.name, "output": result}

            conversation.add("agent", json.dumps({"tool": tool_def.name, "arguments": response.tool_call.arguments}))
            conversation.add("tool_result", result)

            gain = tracker.measure(tool_def.name, result)
            yield {"type": "info_gain", "tool": tool_def.name, "gain": round(gain, 3),
                   "converged": tracker.converged, "summary": tracker.summary}
            if tracker.converged:
                log("INFO", f"Convergence detected — nudging model to synthesize. Gains: {tracker.summary['gains']}")
                yield {"type": "convergence", "message": "Low information gain detected — synthesizing findings.",
                       "gains": tracker.summary["gains"]}
                conversation.add("system", CONVERGENCE_NUDGE)

    yield {"type": "error", "content": "Agent hit max iterations without a final answer."}


if __name__ == "__main__":
    log("INFO", "Starting agent...")
    config = initialize_config()
    client = initialize_genai_client(config)
    log("INFO", "Gemini client initialized successfully.")

    user_input = "Compare Redis, Memcached, and DragonflyDB for high-throughput caching in a distributed microservices architecture. Consider performance benchmarks, community adoption, and any recent academic research on in-memory data stores."
    agent_loop(user_input, client, tool_registry, config)