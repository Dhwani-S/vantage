# Vantage — Real-Time Collaborative Web Highlighter

**Vantage** (formerly *Context Scribe — The Sovereign Scholar*) is a Chrome extension that lets you highlight, annotate, and share text on any webpage. It works locally out of the box, and optionally syncs highlights in real-time across users via Firebase — no accounts, no servers to maintain.

Built with **Chrome Manifest V3**, plain JavaScript, and zero build tools.

---

## Features

### Highlighting
- Select text on any webpage and highlight it in **5 colors** (yellow, green, blue, pink, orange)
- Color picker action bar appears on text selection
- Add **notes** to any highlight via a tooltip editor
- Keyboard shortcut: `Alt + H` to quick-highlight
- Right-click context menu: *"Highlight with Context Scribe"*
- Works on SPAs (Single Page Applications) — detects URL changes automatically

### Dashboard
- Full-screen management view for all your highlights
- Group by **domain** or **date**, or view all
- **Search** across highlight text, notes, URLs, and page titles
- Select and **bulk-delete** highlights
- **Harvest Markdown** — export all highlights as a formatted `.md` file
- Domain sidebar with highlight counts

### Knowledge Packs (Offline Sharing)
- **Export Pack** — save selected (or all) highlights as a `.cscribe` JSON file
- **Import Pack** — load a colleague's pack file to merge their highlights with yours
- Deduplication by highlight ID prevents duplicates on re-import
- Import multiple packs sequentially — they stack cleanly

### Cloud Packs (Real-Time Sync)
- **Create a Cloud Pack** — generates a room key like `CS-A1B2-C3D4`
- **Join a Cloud Pack** — enter a room key to subscribe
- Real-time sync via **Firebase Realtime Database REST API + Server-Sent Events**
- Zero SDK — uses only native `fetch()` and `EventSource` APIs
- When User A highlights text, User B sees it painted on their screen **instantly** (if on the same URL)
- Notes sync to the cloud too
- Cloud highlights marked with a "shared" badge in the dashboard
- Cloud is **opt-in** — the extension works fully offline without any Firebase config

### Theming
- Dark mode (default) and light mode
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

Click **Open Dashboard** in the popup (or the extension icon menu) to manage all your highlights across all pages.

### Export & Import Packs

1. In the Dashboard, click **Export Pack** to download a `.cscribe` file
2. Share this file with colleagues
3. They click **Import Pack** in their Dashboard and select the file
4. Highlights merge automatically — no duplicates

---

## Cloud Packs Setup (Optional)

Cloud Packs enable real-time collaborative highlighting. You need a free Firebase project.

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
3. Paste the URL in the **Cloud Pack** section
4. Click **Create Pack** to generate a room key

### 4. Invite Collaborators

1. Share your room key (e.g. `CS-A1B2-C3D4`) with teammates
2. They install the extension, paste the same Firebase URL, click **Join Pack**, and enter the key
3. Now any highlight on a matching URL syncs live across all participants

---

## Architecture

```
vantage/
├── manifest.json          # Chrome MV3 manifest
├── background.js          # Service worker — message router, cloud pack CRUD
├── cloud.js               # Firebase REST + SSE client (CloudSync class)
├── content.js             # Content script — highlighting, painting, tooltips
├── content.css            # Highlight & tooltip styles
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.js           # Popup logic — stats, toggle, cloud pack controls
│   └── popup.css          # Popup styles
├── dashboard/
│   ├── dashboard.html     # Full-screen dashboard
│   ├── dashboard.js       # Dashboard logic — grouping, search, export/import
│   └── dashboard.css      # Dashboard styles
└── icons/                 # Extension icons (16, 48, 128px)
```

### How Cloud Sync Works

```
User A highlights text
  → content.js saves locally (chrome.storage)
  → cloud.js PUTs to Firebase REST API
  → Firebase streams SSE event to all subscribers
  → User B's content.js receives the event
  → Paints the highlight on their page instantly
```

- The **content script** manages the SSE connection (alive as long as the tab is open)
- The **service worker** handles room creation/joining (ephemeral, per MV3 design)
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
| Styling | Plain CSS with CSS custom properties (dark/light theme) |

---

## License

MIT

---

## Author

**Dhwani Suthar** — [GitHub](https://github.com/Dhwani-S)
