"""
Demo 8: Talk to an LLM
First step — just call the API and see what comes back.

Before running:
  pip install google-genai python-dotenv
  Create a .env file next to this script with:
    GEMINI_API_KEY=your-key-here
    GEMINI_MODEL=gemini-2.5-flash-lite
"""
from google import genai
import os
import time
from dotenv import load_dotenv

load_dotenv()  # reads .env in the current directory

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

print(f"Using model: {GEMINI_MODEL}\n")

# Test 1: Something it CAN do (sort of)
print("=" * 50)
print("Test 1: Math question")
print("=" * 50)
q1 = "What is 2 raised to the power of 10?"
print(f"Q: {q1}")
print(f"A: {ask(q1)}")
print("(Might be right, might be wrong — it's just predicting text)")

# Test 2: Something it CANNOT do
print(f"\n{'=' * 50}")
print("Test 2: Real-time data")
print("=" * 50)
q2 = "What is the current temperature in Mumbai right now?"
print(f"Q: {q2}")
print(f"A: {ask(q2)}")
print("(This is a GUESS. It has no idea what the actual temperature is.)")

# Test 3: Something it will hallucinate on
print(f"\n{'=' * 50}")
print("Test 3: Calculation it might get wrong")
print("=" * 50)
q3 = "Calculate the sum of exponential values (e^x) of the first 6 Fibonacci numbers (1,1,2,3,5,8). Give just the number."
print(f"Q: Sum of e^x for first 6 Fibonacci numbers")
print(f"A: {ask(q3)}")

# Test 4: What is the capital of France?
print(f"\n{'=' * 50}")
print("Test 4: General knowledge question")
print("=" * 50)
q4 = "What is the capital of France?"
print(f"Q: {q4}")
print(f"A: {ask(q4)}")

import math
actual = sum(math.exp(x) for x in [1, 1, 2, 3, 5, 8])
print(f"\nActual answer: {actual:.4f}")
print("(Compare — did the LLM get it right?)")
print("\nThis is WHY we need agents. LLMs can reason but they can't reliably ACT.")
print("An agent would call a calculate() tool and get the exact answer.")
