"""
Demo 7: Python essentials for agentic systems
Covers: try/except, dataclasses, decorators, f-strings
"""
import json
from dataclasses import dataclass

# === try/except: Handling messy LLM responses ===

print("=" * 50)
print("1. try/except — Handling messy LLM responses")
print("=" * 50)

# LLMs sometimes wrap JSON in markdown code fences
messy_response = '```json\n{"tool": "calculate", "args": {"expr": "2+2"}}\n```'

print(f"Messy LLM response: {messy_response}")

# This will crash:
try:
    data = json.loads(messy_response)
except json.JSONDecodeError as e:
    print(f"Direct parse failed: {e}")

    # Clean it up and try again
    cleaned = messy_response.strip().strip('`').strip()
    if cleaned.startswith('json'):
        print("cleaned: ", cleaned)
        cleaned = cleaned[4:].strip()
    data = json.loads(cleaned)
    print(f"After cleaning: {data}")


# === dataclasses: Contracts between LLM and tools ===

print(f"\n{'=' * 50}")
print("2. dataclasses — Contracts between LLM and tools")
print("=" * 50)

@dataclass
class ToolCall:
    name: str
    arguments: dict

@dataclass
class AgentResponse:
    tool_call: ToolCall | None = None
    final_answer: str | None = None

# Creating a tool call response
response = AgentResponse(
    tool_call=ToolCall(name="calculate", arguments={"expression": "2**10"})
)
print(f"Tool call: {response.tool_call.name}({response.tool_call.arguments})")

# Creating a final answer response
response2 = AgentResponse(final_answer="The result is 1024.")
print(f"Final answer: {response2.final_answer}")


# === Decorators: Tool registration ===

print(f"\n{'=' * 50}")
print("3. Decorators — Automatic tool registration")
print("=" * 50)

TOOLS = {}

def tool(func):
    """Decorator that registers a function as a tool"""
    TOOLS[func.__name__] = func
    return func

@tool
def calculate(expression: str) -> str:
    """Evaluate a mathematical expression"""
    return str(eval(expression))

@tool
def get_weather(city: str) -> str:
    """Get current weather for a city"""
    return f"Weather in {city}: 28°C, partly cloudy"

@tool
def reverse_text(text: str) -> str:
    """Reverse a string"""
    return text[::-1]

print(f"Registered tools: {list(TOOLS.keys())}")

# Call any tool by name — this is how agents dispatch tool calls
tool_name = "calculate"
tool_args = {"expression": "2**10"}
result = TOOLS[tool_name](**tool_args)
print(f"Called {tool_name}({tool_args}) → {result}")

tool_name = "reverse_text"
tool_args = {"text": "TSAI EAG V3"}
result = TOOLS[tool_name](**tool_args)
print(f"Called {tool_name}({tool_args}) → {result}")


# === f-strings: Building system prompts dynamically ===

print(f"\n{'=' * 50}")
print("4. f-strings — Dynamic system prompts")
print("=" * 50)

# Build tool descriptions dynamically from registered tools
tool_descriptions = []
for name, func in TOOLS.items():
    doc = func.__doc__ or "No description"
    tool_descriptions.append(f"  - {name}: {doc}")

tool_list = "\n".join(tool_descriptions)

system_prompt = f"""You are a helpful AI agent with access to these tools:

{tool_list}

Respond in JSON format with either a tool call or final answer."""

print(system_prompt)
