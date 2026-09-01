# AEP Assist — UI Server Setup

This is the customer-facing chat UI. It's a Node.js/Express app that calls your Flowise **master agentflow** (the orchestrator sitting above all six modules) and adds the "suggested follow-up question" chips on top of each response.

---

## 1. Prerequisites

- Node.js 18 or later (and npm)
- Flowise already running, with your master agentflow imported and its **Chatflow ID** noted
- These files together in one folder:
  - `server.js`
  - `package.json`
  - `package-lock.json`
- `index.html` placed inside a **`public/`** subfolder — the server serves it from there (`public/index.html`), it won't be found sitting next to `server.js` directly:
  ```
  your-folder/
    server.js
    package.json
    package-lock.json
    public/
      index.html
  ```

---

## 2. Install dependencies

```bash
npm install
```

Since `package-lock.json` is included, this installs the exact same dependency versions every time — `axios`, `dotenv`, `express`, `express-session`, `uuid`.

---

## 3. Create your `.env` file

The server loads `GROQ_API_KEY` from environment variables via `dotenv`. In the same folder as `server.js`, create a file named `.env`:

```
GROQ_API_KEY=your_groq_api_key_here
```

This key is used for a **direct** Groq call (separate from Flowise) that generates the follow-up suggestion chips shown under each response. If it's missing, the app still works — chat and answers function normally — but suggestions quietly fall back to a fixed static question bank instead of dynamically generated ones. So: not required to run the app, but needed for the full suggestion feature to work as designed.

---

## 4. Point it at your Flowise instance

Two values are hardcoded near the top of `server.js` rather than read from `.env` — open the file and check/update these before running:

```js
const FLOWISE_BASE_URL = "http://localhost:3000";
const FLOWISE_CHATFLOW_ID = "4189da03-3365-4d4b-9bda-d5e824104f28";
```

- `FLOWISE_BASE_URL` — where your Flowise instance is running. Update this if Flowise is on a different machine or port.
- `FLOWISE_CHATFLOW_ID` — the ID of your **master agentflow** (the orchestrator), not any individual module's chatflow ID. Get this from Flowise's UI — open the master agentflow and copy the ID from its URL.

There's a second, separate Flowise host reference inside `streamFlowiseToClient()` (`hostname: "localhost", port: 3000`) used for the actual streaming call — make sure that matches `FLOWISE_BASE_URL` too if you change it.

---

## 5. Run the server

```bash
npm start
```

For auto-restart on file changes while you're actively editing, use the dev script instead (needs `nodemon` installed globally or as a dev dependency — it's referenced in `package.json` but not listed under `dependencies`, so add it if `npm run dev` fails):
```bash
npm run dev
```

You should see:
```
✅ AEP eCommerce Assistant running at http://localhost:3001
```

---

## 6. Open the UI

Visit `http://localhost:3001` in a browser. For the demo, this is the front door — customers/leadership interact with this page, which talks to Flowise behind the scenes.

---

## Notes

- **Run order matters:** Flowise itself, the embedding server, both guardrail servers, and both MCP servers should all be running *before* you start this one — this UI is the top of the stack and will show errors or empty responses if anything underneath it isn't up yet.
- The Express session secret is hardcoded (`"aep-ecommerce-secret"`) — fine for a demo, should be moved to `.env` and randomized before this runs anywhere beyond a controlled demo.
- Session data (conversation history, execution log, suggestion rotation state) is stored in memory only — restarting the server clears all active conversations. Expected behavior for a demo, just don't restart mid-conversation.
- If suggestion chips look wrong or generic, check two things in order: is `GROQ_API_KEY` set correctly, and is the master agentflow's node ID map (`NODE_LABELS` near the top of `server.js`) still accurate — that map is hand-tuned to specific node IDs in your Flowise agentflow, so if the flow structure changes in Flowise, this file needs to be updated to match.
