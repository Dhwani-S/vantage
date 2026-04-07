# Vantage - Collaborative Web Highlighter

## Demo

[![Watch the demo](https://img.youtube.com/vi/ebned4QDEWw/0.jpg)](https://youtu.be/ebned4QDEWw)

---

**Vantage** is a Chrome extension that lets engineers annotate, highlight, and share a point-of-view overlay on any webpage. It works locally out of the box, and optionally syncs highlights in real-time across users via Firebase — no accounts, no servers to maintain.

Built with **Chrome Manifest V3**, plain JavaScript, and zero build tools.

---

## Features

### Annotations
- Select text on any webpage and highlight it in **5 colors** (yellow, green, blue, pink, orange)
- Color picker action bar appears on text selection
- Add **notes** to any highlight via a tooltip editor
- Keyboard shortcut: `Alt + H` to quick-highlight
- Right-click context menu: *"Annotate with Vantage"*
- Works on SPAs (LinkedIn, Twitter, etc.) — detects URL changes automatically

### Role-Based Access
- **Viewer** — read-only access to shared annotations
- **Commentor** — can create highlights and add notes
- **Editor** — full access including edit and delete
- Read-only badges shown in dashboard; delete actions gated by role

### Dashboard
- Full-screen management view for all your annotations
- Group by **domain** or **date**, or view all
- **Search** across highlight text, notes, URLs, and page titles
- Select and **bulk-delete** annotations (respects role permissions)
- **Harvest Markdown** — export all annotations as a formatted `.md` file
- Domain sidebar with annotation counts
- **Clear All** button for fresh starts (wipes local data + disconnects cloud)

### Knowledge Packs (Offline Sharing)
- **Export Pack** — save selected (or all) annotations as a `.cscribe` JSON file
- **Import Pack** — load a colleague's pack file to merge their annotations with yours
- Deduplication by highlight ID prevents duplicates on re-import

### Cloud Rooms (Real-Time Sync)
- **Create a Room** — generates a room key like `CS-A1B2-C3D4`
- **Join a Room** — enter a room key to subscribe
- Real-time sync via **Firebase Realtime Database REST API + Server-Sent Events**
- Zero SDK — uses only native `fetch()` and `EventSource` APIs
- Cloud annotations are proactively fetched on room join and SPA navigation
- Deferred painting with retry for SPAs that render content asynchronously
- Cloud annotations marked with a "shared" badge in the dashboard
- Cloud is **opt-in** — the extension works fully offline without any Firebase config

### Design
- **Minimalist & technical** aesthetic (inspired by Linear/Vercel)
- **Glassmorphism** — semi-transparent `backdrop-blur` overlays for tooltips and sidebars
- Dark mode (default) and light mode
- Monospace fonts for technical metadata; clean sans-serif for UI text
- Lucide-style SVG icons throughout
- Theme syncs across popup, dashboard, and in-page tooltips

---

## Installation

### From Source (Developer Mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/Dhwani-S/vantage.git
   ```

2. Open Chrome and go to `chrome://extensions`

3. Enable **Developer mode** (toggle in the top-right)

4. Click **Load unpacked** and select the cloned `vantage` folder

5. The extension icon appears in your toolbar — you're ready to go

---

## Usage

### Basic Highlighting

1. Select text on any webpage
2. A color picker bar appears — click a color
3. The text is highlighted and a note tooltip opens
4. Add an optional note, then press the checkmark or `Ctrl + Enter` to save

### Keyboard Shortcut

Press `Alt + H` with text selected to instantly highlight in yellow.

### Dashboard

Click **Open Dashboard** in the popup to manage all your annotations across all pages.

### Export & Import Packs

1. In the Dashboard, click **Export Pack** to download a `.cscribe` file
2. Share this file with colleagues
3. They click **Import Pack** in their Dashboard and select the file
4. Annotations merge automatically — no duplicates

---

## Cloud Rooms Setup (Optional)

Cloud Rooms enable real-time collaborative annotating. You need a free Firebase project.

### 1. Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Click **Add project** and follow the wizard
3. In the sidebar, go to **Databases and storage** > **Realtime Database**
4. Click **Create Database**, pick any region, and select **Start in test mode**

### 2. Set Database Rules

Go to the **Rules** tab and set:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

Click **Publish**. (These are open rules for development — add authentication for production use.)

### 3. Connect the Extension

1. Copy your database URL from the Realtime Database page (e.g. `https://your-project-default-rtdb.firebaseio.com`)
2. Open the Vantage popup
3. Paste the URL in the **Shared POV** section
4. Click **Create Room** to generate a room key

### 4. Invite Collaborators

1. Share your room key (e.g. `CS-A1B2-C3D4`) with teammates
2. They install the extension, paste the same Firebase URL, click **Join Room**, and enter the key
3. Now any annotation on a matching URL syncs live across all participants

---

## Architecture

```
vantage/
├── manifest.json          # Chrome MV3 manifest
├── background.js          # Service worker — message router, room CRUD, role mgmt
├── cloud.js               # Firebase REST + SSE client (CloudSync class)
├── content.js             # Content script — highlighting, painting, tooltips, cloud sync
├── content.css            # Highlight & tooltip styles (glassmorphism)
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.js           # Popup logic — stats, toggle, cloud room controls
│   └── popup.css          # Popup styles
├── dashboard/
│   ├── dashboard.html     # Full-screen dashboard
│   ├── dashboard.js       # Dashboard logic — grouping, search, export/import, roles
│   └── dashboard.css      # Dashboard styles
└── icons/                 # Extension icons (16, 48, 128px SVG-derived)
```

### How Cloud Sync Works

```
User A annotates text
  → content.js saves locally (chrome.storage)
  → cloud.js PUTs to Firebase REST API
  → Firebase streams SSE event to all subscribers
  → User B's content.js receives the event
  → Saves to local storage immediately
  → Paints the highlight (with retries for SPA content)
```

- The **content script** manages the SSE connection (alive as long as the tab is open)
- The **service worker** handles room creation/joining (ephemeral, per MV3 design)
- **Proactive fetch** on init and SPA navigation ensures existing highlights are loaded
- No SDK, no WebSocket library — just `fetch()` and `EventSource`

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Extension | Chrome Manifest V3 |
| Language | Vanilla JavaScript (no framework, no bundler) |
| Storage | `chrome.storage.local` |
| Cloud Sync | Firebase Realtime Database REST API |
| Real-Time | Server-Sent Events (SSE) via `EventSource` |
| Styling | CSS with custom properties, `backdrop-filter` glassmorphism |
| Icons | Lucide-style inline SVGs |

---

## License

MIT

---

## Author

**Dhwani Suthar** — [GitHub](https://github.com/Dhwani-S)
