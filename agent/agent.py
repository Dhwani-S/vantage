import json
import time
import os
import requests
import re
from google import genai
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()

import warnings
warnings.filterwarnings("ignore", category=UserWarning, module="wikipedia")

# File-based logging: write to agent/logs/
LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE = os.path.join(LOG_DIR, f"agent_{time.strftime('%Y%m%d_%H%M%S')}.log")
_log_file_handle = None

def _get_log_file():
    global _log_file_handle
    if _log_file_handle is None:
        _log_file_handle = open(LOG_FILE, "a", encoding="utf-8")
    return _log_file_handle

def _write_log(line: str):
    f = _get_log_file()
    f.write(line + "\n")
    f.flush()

def log(label: str, message: str = "", data: dict = None):
    timestamp = time.strftime("%H:%M:%S")

    def out(text=""):
        print(text)
        _write_log(text)

    # If message looks like JSON, pretty-print it
    if isinstance(message, str):
        stripped = message.strip()
        if stripped.startswith(("{", "[")):
            try:
                parsed = json.loads(stripped)
                message = json.dumps(parsed, indent=2)
            except (json.JSONDecodeError, ValueError):
                pass

    # Visual separators for key moments
    if label == "USER":
        out(f"\n{'='*60}")
        out(f"  [{timestamp}] USER QUERY")
        out(f"  {message}")
        out(f"{'='*60}")
    elif label == "SYSTEM":
        out(f"\n{'-'*60}")
        out(f"  [{timestamp}] SYSTEM PROMPT")
        for line in message.split('\n'):
            out(f"  {line}")
        out(f"{'-'*60}")
    elif label == "ANSWER":
        out(f"\n{'='*60}")
        out(f"  [{timestamp}] FINAL ANSWER")
        out(f"{'='*60}")
        out(message)
        out(f"{'='*60}\n")
    elif label == "TOOL":
        args_str = ", ".join(f"{k}={v}" for k, v in (data or {}).items())
        out(f"  [{timestamp}] TOOL >> {message} ({args_str})")
        return
    elif label == "TOOL_RESULT":
        output = (data or {}).get("output", "")
        # Full output goes to file, truncated to terminal
        _write_log(f"  [{timestamp}] TOOL << {message}")
        _write_log(output)
        _write_log("")
        if len(output) > 400:
            output = output[:400] + "... [truncated]"
        print(f"  [{timestamp}] TOOL << {message}")
        for line in output.split('\n'):
            print(f"           {line}")
        print()
        return
    elif label == "ERROR":
        out(f"  [{timestamp}] !! {message}")
    elif label == "WARN":
        out(f"  [{timestamp}] ?? {message}")
    elif label == "INFO":
        out(f"  [{timestamp}] .. {message}")
    else:
        out(f"  [{timestamp}] [{label}] {message}")

    if data and label not in ("TOOL", "TOOL_RESULT"):
        for key, value in data.items():
            if isinstance(value, str):
                sv = value.strip()
                if sv.startswith(("{", "[")):
                    try:
                        value = json.dumps(json.loads(sv), indent=2)
                    except (json.JSONDecodeError, ValueError):
                        pass
            out(f"           | {key}: {value}")
    out()

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
    GEMINI_API_KEY = config["GEMINI_API_KEY"]
    client = genai.Client(api_key=GEMINI_API_KEY)
    return client

@dataclass
class Message:
    role: str
    content: str

@dataclass
class Conversation:
    messages: list[Message]

    def add(self, role: str, content: str):
        self.messages.append(Message(role=role, content=content))

    def to_prompt(self) -> list[dict]:
        return [{"role": msg.role, "content": msg.content} for msg in self.messages]
    
@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: dict
    function: callable

@dataclass
class ToolCall:
    name: str
    arguments: dict

@dataclass
class ToolResult:
    tool_name: str
    output: str
    error: str | None = None

@dataclass
class AgentResponse:
    content: str | None
    tool_call: ToolCall | None

    @property
    def is_final(self) -> bool:
        return self.tool_call is None

tool_registry: list[ToolDefinition] = []
def tool(name: str, description: str, parameters: dict):
    def decorator(func):
        tool_registry.append(ToolDefinition(
            name=name, 
            description=description, 
            parameters=parameters, 
            function=func))
        return func
    return decorator

@tool(
    name="search_wikipedia",
    description="Fetches official background context from Wikipedia for a given topic.",
    parameters={"topic": {"type": "string", "description": "The topic to search on Wikipedia"}}
)
def search_wikipedia(topic: str) -> str:
    """Fetches official background context from Wikipedia."""
    import wikipedia
    try:
        results = wikipedia.search(topic, results=3)
        if not results:
            return f"No Wikipedia articles found for '{topic}'."
        
        summaries = []
        for title in results:
            try:
                page = wikipedia.page(title, auto_suggest=False)
                summary = page.summary[:300] + "..." if len(page.summary) > 300 else page.summary
                summaries.append(f"**{page.title}**: {summary}")
            except (wikipedia.DisambiguationError, wikipedia.PageError):
                continue
        
        return "\n\n".join(summaries) if summaries else f"No summaries found for '{topic}'."
    except Exception as e:
        return f"Error fetching Wikipedia data: {str(e)}"


@tool(
    name="search_hacker_news",
    description="Searches Hacker News for developer discussions, sentiment, and community opinions on a topic.",
    parameters={"query": {"type": "string", "description": "The search query to find discussions on Hacker News"}}
)
def search_hacker_news(query: str) -> str:
    """Searches Hacker News for developer sentiment."""
    try:
        res = requests.get(
            "https://hn.algolia.com/api/v1/search",
            params={"query": query, "hitsPerPage": 5, "tags": "story"}
        )
        if res.status_code != 200:
            return "Error from Hacker News API."
        
        hits = res.json().get("hits", [])
        if not hits:
            return f"No Hacker News discussions found for '{query}'."
        
        results = []
        for h in hits:
            title = h.get("title", "Untitled")
            points = h.get("points", 0)
            comments = h.get("num_comments", 0)
            url = h.get("url", "")
            results.append(f"- {title} ({points} points, {comments} comments) {url}")
        
        return "\n".join(results)
    except Exception as e:
        return f"Error searching Hacker News: {str(e)}"


@tool(
    name="search_github_repos",
    description="Searches GitHub for popular open-source repositories related to a topic, sorted by stars.",
    parameters={"topic": {"type": "string", "description": "The topic to search GitHub repositories for"}}
)
def search_github_repos(topic: str) -> str:
    """Searches GitHub for open-source popularity."""
    try:
        res = requests.get(
            "https://api.github.com/search/repositories",
            params={"q": topic, "sort": "stars", "order": "desc", "per_page": 5}
        )
        if res.status_code != 200:
            return "Error from GitHub API."
        
        items = res.json().get("items", [])
        if not items:
            return f"No GitHub repositories found for '{topic}'."
        
        results = []
        for repo in items:
            name = repo.get("full_name", "")
            stars = repo.get("stargazers_count", 0)
            desc = repo.get("description", "No description") or "No description"
            lang = repo.get("language", "N/A") or "N/A"
            results.append(f"- {name} (stars: {stars}, lang: {lang}) -- {desc}")
        
        return "\n".join(results)
    except Exception as e:
        return f"Error searching GitHub: {str(e)}"


@tool(
    name="search_research_papers",
    description="Searches OpenAlex for foundational academic and research papers on a topic.",
    parameters={"query": {"type": "string", "description": "The search query to find academic papers"}}
)
def search_research_papers(query: str) -> str:
    """Searches OpenAlex for foundational academic papers."""
    try:
        res = requests.get(
            "https://api.openalex.org/works",
            params={"search": query, "per-page": 5, "sort": "cited_by_count:desc"}
        )
        if res.status_code != 200:
            return "Error from OpenAlex API."
        
        papers = res.json().get("results", [])
        if not papers:
            return f"No research papers found for '{query}'."
        
        results = []
        for p in papers:
            title = p.get("title", "Untitled")
            year = p.get("publication_year", "N/A")
            citations = p.get("cited_by_count", 0)
            results.append(f"- {title} (Year: {year}, Citations: {citations})")
        
        return "\n".join(results)
    except Exception as e:
        return f"Error searching papers: {str(e)}"
        

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

    # Try full text as JSON first
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

    # LLM sometimes emits a JSON tool call followed by extra text.
    # Try to extract a JSON object from the beginning of the response.
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
    # print(f"Waiting for {config['THROTTLE_RATE']} seconds to respect rate limits...")

    for attempt in range(max_retries):
        try:
            wait = config["THROTTLE_RATE"] * (2 ** attempt)  # Exponential backoff
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
        else:
            log("WARN", "Agent hit max iterations without a final answer.")


def agent_loop_stream(user_input: str, client: genai.Client, tools: list[ToolDefinition], config: dict):
    """Generator version of agent_loop that yields event dicts for SSE streaming."""
    conversation = Conversation(messages=[])
    
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

    yield {"type": "error", "content": "Agent hit max iterations without a final answer."}
            
            
if __name__ == "__main__":
    log("INFO", "Starting agent...")
    config = initialize_config()
    client = initialize_genai_client(config)
    log("INFO", "Gemini client initialized successfully.")

    user_input = "Compare Redis, Memcached, and DragonflyDB for high-throughput caching in a distributed microservices architecture. Consider performance benchmarks, community adoption, and any recent academic research on in-memory data stores."
    agent_loop(user_input, client, tool_registry, config)