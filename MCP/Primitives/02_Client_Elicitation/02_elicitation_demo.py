"""
Demo 2: MCP Elicitation

Server asks the client/user for input mid-tool-execution.
  1. Client calls delete_file tool
  2. Server sends elicitation/create request to client
  3. Client shows the prompt to user, collects response
  4. Client sends back accept/decline/cancel
  5. Server continues based on user's choice

Run: python 02_elicitation_demo.py
"""
import sys
sys.path.insert(0,"..")
import asyncio
import json

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from logged_stream import LoggedStream
import mcp.types as types

async def handle_elicitation(context, params):
    """Called when the server asks the user for input."""
    print(f"\n{'='*30}")
    print(f"SERVER ASKS: {params.message}")
    print(f"\n{'='*30}")

    print("Params: ", json.dumps(params.requestedSchema, indent=2))
    schema = params.requestedSchema
    props = schema.get("properties", {})
    response = {}

    for name, info in props.items():
        field_type = info.get("type", "string")
        if field_type == "boolean":
            answer = input(f"  {name}? (yes/no): ").strip().lower()
            response[name] = answer in ("yes", "y", "true", "1")
        else:
            response[name] = input(f"  {name}: ").strip()

    return types.ElicitResult(
        action="accept",
        content=response,
    )

async def main():
    server_params = StdioServerParameters(
        command="python",
        args=["server.py"],
    )

    async with stdio_client(server_params) as (read, write):
        logged_read =  LoggedStream(read, "<- SERVER")
        logged_write = LoggedStream(write, "-> CLIENT")

        async with ClientSession(
            logged_read, 
            logged_write,
            elicitation_callback=handle_elicitation
        ) as session:
            await session.initialize()
            print("\n Handshake Complete!")

            result = await session.call_tool(
                "delete_file",
                arguments={"filename": "important_document.txt"}
            )
            print("Tool Result: ", result.content[0].text)

if __name__ == "__main__":
    asyncio.run(main())