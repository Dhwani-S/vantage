import json
import sys
from flask import Flask, request, Response
from agent import initialize_config, initialize_genai_client, agent_loop_stream
from tools import tool_registry
from logger import log, LOG_FILE

app = Flask(__name__)

config = initialize_config()
client = initialize_genai_client(config)


@app.before_request
def handle_preflight():
    """Handle CORS + Private Network Access preflight."""
    if request.method == "OPTIONS":
        resp = Response("", status=204)
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        return resp


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


@app.route("/research", methods=["POST"])
def research():
    data = request.get_json()
    query = data.get("query", "").strip()
    log("INFO", f"Research request received: {query}")
    if not query:
        return {"error": "No query provided"}, 400

    def generate():
        try:
            for event in agent_loop_stream(query, client, tool_registry, config):
                log("INFO", f"SSE event: {event.get('type', '?')}")
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            log("ERROR", f"Stream error: {e}")
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.route("/health", methods=["GET"])
def health():
    return {"status": "ok", "tools": [t.name for t in tool_registry]}


if __name__ == "__main__":
    print(f"Agent server running with {len(tool_registry)} tools: {[t.name for t in tool_registry]}", flush=True)
    print(f"Logs writing to: {LOG_FILE}", flush=True)
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
