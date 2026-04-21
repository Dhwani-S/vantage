# Vantage - Collaborative Web Highlighter

## Demo

### 🤖 AI Refine — Harvest with Intelligence
[![Watch the Refine demo](https://img.youtube.com/vi/f8K_pBb26cc/maxresdefault.jpg)](https://youtu.be/f8K_pBb26cc)
*(Click image to watch the AI Refine feature demo)*

### 📌 Full Extension Walkthrough
[![Watch the demo](https://img.youtube.com/vi/ebned4QDEWw/maxresdefault.jpg)](https://youtu.be/ebned4QDEWw)
*(Click image to watch the full Tech Stack Triage demo)*

> 💡 **Recommended:** Turn on captions/CC for the best viewing experience.

### 📝 Blog Post
Read the full write-up on Medium: [Stop Your Team's Research Notes From Looking Like a Collective Ransom Letter](https://medium.com/@dhwani.suthar26/stop-your-teams-research-notes-from-looking-like-a-collective-ransom-letter-%EF%B8%8F-%EF%B8%8F-62e97d36cb6f)

---

**Vantage** is a collaborative, real-time web highlighter built as a Chrome Extension.

**The Problem:** Doing technical research usually involves taking messy screenshots, copy-pasting text into separate documents, and losing all the original context of the webpage. Reading on the web is fundamentally isolated.
**The Solution:** Vantage transforms any website into a multiplayer workspace. It lets users annotate, highlight, and share a point-of-view overlay directly on the DOM. It works locally out of the box, and optionally syncs highlights in real-time across users via an ephemeral Firebase architecture.

Built with **Chrome Manifest V3**, plain JavaScript, and zero build tools.

---

## 🚀 Key Features

### Context-Aware Annotations
- **DOM-Resilient Anchoring:** Unlike standard highlighters that rely on fragile XPaths, Vantage uses a custom algorithm that allows highlights to survive page refreshes, dynamic re-renders, and layout changes.
- Highlight text in **5 colors** via a glassmorphic color picker.
- Add **contextual notes** to any highlight via a tooltip editor.
- Keyboard shortcut (`Alt + H`) and Right-click context menu integration.

### Ephemeral Cloud Rooms (Real-Time Sync)
- **Zero-Login Multiplayer:** Create a room and generate a secure key (e.g., `CS-A1B2-C3D4`) to invite teammates.
- **Server-Sent Events (SSE):** Real-time sync powered by Firebase Realtime Database REST API. No bulky SDKs—just native `fetch()` and `EventSource` APIs.
- Cloud annotations are proactively fetched on room join and automatically paint across SPA navigations.

### Cross-Domain Command Center
- Full-screen dashboard to manage your cross-web research.
- Group highlights by **domain** or **date**, and search across highlight text, notes, and URLs.
- **Harvest Markdown:** Export all annotations as a cleanly formatted `.md` file, ready to be pasted into Jira, Notion, or GitHub PRs.

### AI Refine (Harvest with AI)
- **Refine:** Use AI to intelligently process and refine your harvested annotations into structured, actionable insights.
- Powered by Gemini — transforms raw highlights and notes into polished summaries, action items, or research briefs.

### 🔬 Deep Research Agent
- **Multi-source research at a click:** Ask any research question from the dashboard and get a comprehensive, synthesized answer.
- **Agentic tool use:** A Python-based LLM agent (Gemini) autonomously searches Wikipedia, Hacker News, GitHub, and OpenAlex for academic papers — deciding which tools to call and when.
- **Live agent trace:** Watch the agent's reasoning chain in real-time — each thinking step, tool call, and result is streamed to a collapsible trace panel.
- **Rendered markdown output:** The final answer renders with full markdown support including tables, headings, lists, code blocks, and links.
- **File-based logging:** Every research session is logged to `agent/logs/` for debugging and reproducibility.

### Knowledge Packs (Offline Sharing)
- **Export Pack:** Save selected annotations as a `.cscribe` JSON payload.
- **Import Pack:** Load a colleague's pack file to merge their perspective with yours (with built-in deduplication).

### Role-Based Permissions
- Room owners can manage access levels: **Viewer** (read-only), **Commentor** (add notes), or **Editor** (full delete privileges).
- Instant API key regeneration to lock down compromised rooms.

---

## 🛠 Installation (Developer Mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/Dhwani-S/vantage.git
   ```

2. Open Chrome and navigate to `chrome://extensions`

3. Enable **Developer mode** (toggle in the top-right)

4. Click **Load unpacked** and select the cloned `vantage` folder.

---

## 🔬 Deep Research Agent Setup

The Deep Research feature requires a local Python server.

1. Create a `.env` file in the project root with your Gemini API key:
   ```
   GEMINI_API_KEY=your_key_here
   ```

2. Set up the Python environment:
   ```bash
   cd agent
   python -m venv venv
   venv\Scripts\activate      # Windows
   # source venv/bin/activate  # macOS/Linux
   pip install -r requirements.txt
   ```

3. Start the agent server:
   ```bash
   python server.py
   ```
   The server runs on `http://127.0.0.1:5000`. Logs are written to `agent/logs/`.

4. Open the Vantage dashboard and click **Deep Research** in the sidebar.

---

## ☁️ Cloud Rooms Setup (For Real-Time Sync)

Cloud Rooms are opt-in. The extension works perfectly offline, but to enable multiplayer syncing, you need a free Firebase project.

1. Go to [Firebase Console](https://console.firebase.google.com) and create a project.

2. Navigate to **Realtime Database** and click **Create Database** (Start in test mode).

3. Set your Database Rules to public for testing:

   ```json
   {
     "rules": {
       ".read": true,
       ".write": true
     }
   }
   ```

4. Copy your database URL (e.g., `https://your-project.firebaseio.com`).

5. Open the Vantage extension popup, paste the URL into the **Shared POV** section, and click **Create Room**. Share the generated key with your team!

---

## 🧠 Architecture Diagram

```
vantage/
├── manifest.json          # Chrome MV3 manifest
├── background.js          # Service worker — message router, room CRUD, role mgmt
├── cloud.js               # Firebase REST + SSE client (CloudSync class)
├── content.js             # Content script — Context-Aware anchoring, painting, tooltips
├── content.css            # Highlight & tooltip styles (glassmorphism)
├── popup/                 # Extension popup UI & logic
├── dashboard/             # Full-screen Markdown Harvest & Management UI
├── icons/                 # Extension SVG/PNG assets
└── agent/                 # Deep Research Agent
    ├── agent.py           # LLM agent loop with 4 research tools
    ├── server.py          # Flask SSE server bridging dashboard → agent
    ├── requirements.txt   # Python dependencies
    └── logs/              # Auto-generated research session logs
```

### The Sync Lifecycle

1. **User A** highlights text → `content.js` saves locally.
2. `cloud.js` issues a `PUT` request to the Firebase REST API.
3. Firebase broadcasts an SSE payload to all room subscribers.
4. **User B's** `content.js` receives the event via native `EventSource`.
5. **User B's** DOM paints the new highlight instantly (with retry-logic for React/Vue SPAs).

---

## 💻 Tech Stack

| Component | Technology |
|-----------|-----------|
| Extension Framework | Chrome Manifest V3 |
| Language | Vanilla JavaScript (ES6+) |
| Storage | `chrome.storage.local` |
| Networking | Native `fetch()` & `EventSource` (SSE) |
| Database | Firebase Realtime DB (REST via HTTP) |
| UI/UX | Custom CSS variables, `backdrop-filter` glassmorphism, Lucide SVGs |
| AI / LLM | Gemini (`gemini-3.1-flash-lite-preview`) via `google-genai` SDK |
| Research Agent | Python 3.11+, Flask (SSE streaming), 4 tool integrations |

---

## License

MIT

---

## Author

**Dhwani Suthar** — [GitHub](https://github.com/Dhwani-S)
