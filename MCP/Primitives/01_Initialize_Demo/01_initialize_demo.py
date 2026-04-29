"""
Demo 1: MCP Initialize Handshake

Shows the JSON-RPC messages exchanged during session.initialize():
  1. Client sends  → initialize request
  2. Server replies ← initialize result (capabilities, protocol version)
  3. Client sends  → notifications/initialized

Run from MCP/Primitives/:
  python 01_initialize_demo.py
"""
import sys
sys.path.insert(0,"..")
import asyncio
import json 

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.shared.message import SessionMessage

from logged_stream import LoggedStream

async def main():
    server_params = StdioServerParameters(
        command="python",
        args=["server.py"],
    )

    async with stdio_client(server_params) as (read, write):
        logged_read =  LoggedStream(read, "<- SERVER")
        logged_write = LoggedStream(write, "-> CLIENT")

        async with ClientSession(logged_read, logged_write) as session:
            await session.initialize()
            print("\n Handshake Complete!")

if __name__ == "__main__":
    asyncio.run(main())