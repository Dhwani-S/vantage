"""
Demo 9: Give the LLM a system prompt that makes it an agent
Watch how the same LLM behaves differently with the right instructions.

Before running:
  pip install google-genai python-dotenv
  Create a .env file next to this script with:
    GEMINI_API_KEY=your-key-here
    GEMINI_MODEL=gemini-2.5-flash-lite
"""
from google import genai
import json
import os
import time
from dotenv import load_dotenv

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite-preview")
THROTTLE_SECONDS = 10  # Wait before each LLM call to stay under free-tier RPM limits

if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY not set. Create a .env file with GEMINI_API_KEY=...")

client = genai.Client(api_key=GEMINI_API_KEY)


def ask(prompt: str) -> str:
    """Send a prompt to Gemini and return the text response.

    Sleeps for THROTTLE_SECONDS before each call to stay under the free-tier
    rate limit (Gemini 3.1 Flash Lite: 15 RPM, 500 RPD).
    """
    print(f"  [waiting {THROTTLE_SECONDS}s to respect rate limits...]", flush=True)
    time.sleep(THROTTLE_SECONDS)
    response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
    return response.text

system_prompt = """You are a helpful AI agent that can use tools to answer questions.

You have access to the following tools:

1. calculate(expression: str) -> str
   Evaluate a mathematical expression. Example: calculate("2**10")

2. get_weather(city: str) -> str
   Get the current weather for a city. Example: get_weather("Mumbai")

3. search_notes(query: str) -> str
   Search through user's notes. Example: search_notes("meeting agenda")

You must respond in ONE of these two JSON formats:

If you need to use a tool:
{"tool_name": "<name>", "tool_arguments": {"<arg_name>": "<value>"}}

If you have the final answer:
{"answer": "<your final answer>"}

IMPORTANT: Respond with ONLY the JSON. No other text. No markdown. No code fences.
"""

test_queries = [
    "What is the weather in Mumbai?",
    "What is 2 raised to the power of 10?",
    "Do I have any notes about meetings?",
    "What is the capital of France?",  # No tool needed — should give direct answer
]

for query in test_queries:
    print(f"\n{'=' * 50}")
    print(f"User: {query}")
    print("=" * 50)

    response_text = ask(f"{system_prompt}\n\nUser: {query}")
    print(f"Raw response: {response_text}")

    try:
        parsed = json.loads(response_text.strip())
        print(f"Parsed: {json.dumps(parsed, indent=2)}")

        if "tool_name" in parsed:
            print(f"  → LLM wants to call: {parsed['tool_name']}({parsed.get('tool_arguments', {})})")
        elif "answer" in parsed:
            print(f"  → LLM has final answer: {parsed['answer']}")
    except json.JSONDecodeError:
        print(f"  → Failed to parse! LLM didn't follow instructions perfectly.")
        print(f"  → This is NORMAL. This is why we need robust parsing.")
