from mcp.server.fastmcp import FastMCP

mcp = FastMCP("Demo Server")

@mcp.tool()
def reverse_string(text: str) -> str:
    """Reverses the input string."""
    return text[::-1]

if __name__ == "__main__":
    mcp.run()