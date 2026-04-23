import json
import time
import os

# File-based logging: write to agent/logs/
LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE = os.path.join(LOG_DIR, f"agent_{time.strftime('%Y%m%d_%H%M%S')}.log")
_log_file_handle = None

def _get_log_file():
    global _log_file_handle
    if _log_file_handle is None:
        _log_file_handle = open(LOG_FILE, "a", encoding="utf-8")
    return _log_file_handle

def _write_log(line: str):
    f = _get_log_file()
    f.write(line + "\n")
    f.flush()

def log(label: str, message: str = "", data: dict = None):
    timestamp = time.strftime("%H:%M:%S")

    def out(text=""):
        print(text)
        _write_log(text)

    # If message looks like JSON, pretty-print it
    if isinstance(message, str):
        stripped = message.strip()
        if stripped.startswith(("{", "[")):
            try:
                parsed = json.loads(stripped)
                message = json.dumps(parsed, indent=2)
            except (json.JSONDecodeError, ValueError):
                pass

    # Visual separators for key moments
    if label == "USER":
        out(f"\n{'='*60}")
        out(f"  [{timestamp}] USER QUERY")
        out(f"  {message}")
        out(f"{'='*60}")
    elif label == "SYSTEM":
        out(f"\n{'-'*60}")
        out(f"  [{timestamp}] SYSTEM PROMPT")
        for line in message.split('\n'):
            out(f"  {line}")
        out(f"{'-'*60}")
    elif label == "ANSWER":
        out(f"\n{'='*60}")
        out(f"  [{timestamp}] FINAL ANSWER")
        out(f"{'='*60}")
        out(message)
        out(f"{'='*60}\n")
    elif label == "TOOL":
        args_str = ", ".join(f"{k}={v}" for k, v in (data or {}).items())
        out(f"  [{timestamp}] TOOL >> {message} ({args_str})")
        return
    elif label == "TOOL_RESULT":
        output = (data or {}).get("output", "")
        # Full output goes to file, truncated to terminal
        _write_log(f"  [{timestamp}] TOOL << {message}")
        _write_log(output)
        _write_log("")
        if len(output) > 400:
            output = output[:400] + "... [truncated]"
        print(f"  [{timestamp}] TOOL << {message}")
        for line in output.split('\n'):
            print(f"           {line}")
        print()
        return
    elif label == "ERROR":
        out(f"  [{timestamp}] !! {message}")
    elif label == "WARN":
        out(f"  [{timestamp}] ?? {message}")
    elif label == "INFO":
        out(f"  [{timestamp}] .. {message}")
    else:
        out(f"  [{timestamp}] [{label}] {message}")

    if data and label not in ("TOOL", "TOOL_RESULT"):
        for key, value in data.items():
            if isinstance(value, str):
                sv = value.strip()
                if sv.startswith(("{", "[")):
                    try:
                        value = json.dumps(json.loads(sv), indent=2)
                    except (json.JSONDecodeError, ValueError):
                        pass
            out(f"           | {key}: {value}")
    out()
