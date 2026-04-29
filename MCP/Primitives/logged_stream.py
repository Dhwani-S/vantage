import json
from mcp.shared.message import SessionMessage


class LoggedStream:
    """Wraps a read or write stream to print JSON-RPC messages."""

    def __init__(self, stream, label):
        self._stream = stream
        self._label = label

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.aclose()

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            msg = await self.receive()
            return msg
        except Exception:
            raise StopAsyncIteration

    async def receive(self):
        msg = await self._stream.receive()
        if isinstance(msg, SessionMessage):
            raw = json.loads(
                msg.message.model_dump_json(by_alias=True, exclude_none=True)
            )
            print(f"{self._label} {json.dumps(raw, indent=2)}")
        return msg

    async def send(self, msg):
        if isinstance(msg, SessionMessage):
            raw = json.loads(
                msg.message.model_dump_json(by_alias=True, exclude_none=True)
            )
            print(f"{self._label} {json.dumps(raw, indent=2)}")
        await self._stream.send(msg)

    async def aclose(self):
        await self._stream.aclose()
