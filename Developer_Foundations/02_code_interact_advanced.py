"""
Demo 2: code.interact() for debugging agents — GUIDED TOUR
=======================================================================

Run this and follow along. You'll be prompted to press Enter between steps
and given specific commands to try inside the interactive shell.

The goal: see WHY code.interact() is powerful for debugging agent loops.
"""
import code
import json 

_SIMULATED_RESPONSES = [
    # Iteration 1
    '{"tool_name": "get_weather", "tool_args": {"city": "Gujarat"}}',
    # Iteration 2
    '{"answer": "The weather in Gujarat is sunny with a high of 35°C."}'
]
_response_index = 0

def mock_call_llm(conversation):
    "Pretend this is calling an LLM and getting a response based on the conversation history."
    global _response_index
    resp = _SIMULATED_RESPONSES[_response_index]
    _response_index += 1
    return resp

def get_weather(city: str) -> str:
    return json.dumps({"weather": "35°C, sunny"})

tools = {"get_weather": get_weather}

# ─────────────────────────────────────────────────────────────
# Helpers for the guided tour
# ─────────────────────────────────────────────────────────────
def pause(message="Press Enter to continue..."):
    """Helper to pause execution and wait for user input."""
    input(message)

def banner(text, char="="):
    """Helper to print a banner for better readability."""
    print(f"\n{char * 10} {text} {char * 10}\n")

def narrator(text):
    """Helper to print narration text."""
    print()
    for line in text.strip().split("\n"):
        print(f" → {line}\n")

# ─────────────────────────────────────────────────────────────
# The guided agent loop
# ─────────────────────────────────────────────────────────────
def guided_agent_loop(user_query):
    banner(f"GUIDED TOUR: Debugging an Agent Loop with code.interact()")

    narrator(f"""
        This is a SIMULATED agent. The LLM responses are hardcoded so we can
        focus on ONE thing: how code.interact() lets you peek inside the loop.

        User's query: "{user_query}"

        The agent will:
        1. Ask the LLM what to do
        2. Parse the response
        3. Call a tool if needed
        4. Repeat until it has a final answer

        At key moments, we'll FREEZE execution and drop into a Python shell
        so you can inspect the program's state with your own eyes.
        """)
    
    pause("Press ENTER to start the agent...")

    # Initial conversation state
    conversation = [{"role": "user", "content": user_query}]

    for iteration in range(5):
        banner(f"Iteration {iteration + 1}", char="-")

        narrator("About to call the LLM. The LLM will see the full conversation\n"
                 "history so far and decide what to do next.")
        
        pause("Press ENTER to call the LLM...")

        # Step 1: Call the LLM (simulated here)
        llm_response = mock_call_llm(conversation)  

        print(f"LLM Response: {llm_response}")

        # ─────────────────────────────────────────────
        # BREAKPOINT: freeze and let user inspect
        # ─────────────────────────────────────────────
        narrator(f"""
        We're about to process this response. But wait — in REAL agent development,
        this is where things go wrong. The LLM might return broken JSON, the wrong
        tool name, or weird arguments.

        Let's FREEZE the program right here and poke around. I'm going to drop you
        into a live Python shell where EVERY variable in scope is available.

        Try typing these commands one at a time:

            >>> llm_response
                    ...the raw string the LLM returned

            >>> iteration
                    ...which loop iteration we're on

            >>> conversation
                    ...the full message history so far

            >>> len(conversation)
                    ...how many messages deep we are

            >>> tools
                    ...what tools this agent can call

            >>> tools["get_weather"]("Delhi")
                    ...you can even CALL a tool manually from the shell!

        When you're done exploring, press Ctrl+Z to exit the shell and continue.
        """)

        pause("Press ENTER to drop into the interactive shell...")

        print("Dropping into interactive shell. Explore the variables and state as much as you like.")
        code.interact(banner="", local={**locals(), **globals()})
        print("Welcome back from the interactive shell! Let's continue processing the LLM response...")

        # ─────────────────────────────────────────────
        # Now actually process the LLM response
        # ─────────────────────────────────────────────

        print("Raw json string from LLM:", llm_response)
        parsed = json.loads(llm_response)
        print("Parsed LLM response:", parsed)

        if "answer" in parsed:
            narrator(f"The LLM gave a FINAL ANSWER. The loop ends here.")
            print(f"\n  FINAL ANSWER:  {parsed['answer']}")
            break

        if "tool_name" in parsed:
            tool_name = parsed["tool_name"]
            tool_args = parsed["tool_args"]

            narrator(f"The LLM wants to call tool '{tool_name}' with args {tool_args}.\n"
                     f"We'll execute it, then feed the result back to the LLM.")
            
            pause("Press ENTER to execute the tool...")

            result = tools[tool_name](**tool_args)
            print(f"\n  Tool returned:  {result}")

            conversation.append({"role": "assistant", "content": llm_response})
            conversation.append({"role": "tool", "content": result})

            narrator(f"Added the tool call and result to conversation history.\n"
                     f"conversation is now {len(conversation)} messages long.\n"
                     f"In iteration {iteration + 2}, the LLM will see ALL of this.")
            
def summary():
    banner("WHAT YOU JUST SAW", char="=")
    narrator("""
You used code.interact() to freeze a running agent and inspect its state.
This is how you debug real agents in production:

  - Your agent gets stuck? Drop code.interact() into the loop.
  - Wrong tool being called? Drop code.interact() BEFORE the tool call.
  - Conversation getting too long? Print len(conversation) in the shell.
  - Want to test a tool manually? Call it from the shell.

code.interact() is your emergency pause button for agents. Use it.

For structured step-by-step debugging (next breakpoint, step into, etc.),
use pdb instead — see next 03_pdb_basic.py.
""")
    
if __name__ == "__main__":
    guided_agent_loop("What is the weather in Gujarat? Is it hotter than 30 degrees?")
    summary()