from dataclasses import dataclass


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
