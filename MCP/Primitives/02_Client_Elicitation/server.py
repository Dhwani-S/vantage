from mcp.server.fastmcp import FastMCP, Context
from pydantic import BaseModel

mcp = FastMCP("Demo Server for Elicitation")

class Confirmation(BaseModel):
    approved: bool

@mcp.tool()
def reverse_string(text: str) -> str:
    """Reverses the input string."""
    return text[::-1]

@mcp.tool()
async def delete_file(ctx: Context, filename: str) -> str:
    """Deletes the specified file after user confirmation."""
    
    result = await ctx.elicit(
        message=f"Are you sure you want to delete '{filename}'?",
        schema = Confirmation
    )

    if result.action == "accept" and result.data.approved:
        return f"Deleted {filename}"
    elif result.action == "decline":
        return f"User declines the action"
    else:
        return "User cancelled"
    
if __name__ == "__main__":
    mcp.run()