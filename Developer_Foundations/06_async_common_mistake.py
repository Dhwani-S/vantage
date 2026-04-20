"""
Demo 6: The async mistake you WILL make
This shows what happens when you forget 'await'.
"""
import asyncio

async def call_llm(prompt: str) -> str:
    """Simulates an async LLM call"""
    await asyncio.sleep(1)  # Simulating network delay
    return f"LLM response to: {prompt}"

async def main():
    # WRONG - forgetting await
    result_wrong = call_llm("Hello")
    print(f"Without await: {result_wrong}")
    print(f"Type: {type(result_wrong)}")
    # This prints: <coroutine object call_llm at 0x...>
    # NOT the actual response!

    print()

    # RIGHT - using await
    result_right = await call_llm("Hello")
    print(f"With await: {result_right}")
    print(f"Type: {type(result_right)}")
    # This prints: "LLM response to: Hello"
    # The ACTUAL response!

asyncio.run(main())
