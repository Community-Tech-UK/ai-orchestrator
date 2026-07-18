export const OBSERVER_STYLES = `:root {
  color-scheme: dark;
  --bg: #09111a;
  --panel: rgba(14, 24, 36, 0.92);
  --panel-alt: rgba(20, 32, 46, 0.9);
  --border: rgba(148, 163, 184, 0.18);
  --text: #e6edf5;
  --muted: #9cb0c3;
  --accent: #4ade80;
  --warning: #fbbf24;
  --error: #f87171;
  --info: #38bdf8;
  --shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--text);
  background:
    radial-gradient(circle at top right, rgba(56, 189, 248, 0.15), transparent 32rem),
    radial-gradient(circle at bottom left, rgba(74, 222, 128, 0.12), transparent 28rem),
    var(--bg);
}

header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 1rem;
  padding: 1.5rem;
}

h1, h2, h3, p { margin: 0; }
h1 { font-size: clamp(2rem, 4vw, 2.8rem); line-height: 0.95; }
h2 { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
p, li, button, input, select { font: inherit; }

.subtitle {
  margin-top: 0.5rem;
  color: var(--muted);
  max-width: 40rem;
}

.toolbar, .stats, .grid, .panel-list, .detail-list, .message-list {
  display: grid;
  gap: 1rem;
}

.toolbar, .stats, .grid {
  padding: 0 1.5rem 1.5rem;
}

.toolbar {
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: end;
}

.toolbar label {
  display: grid;
  gap: 0.35rem;
  color: var(--muted);
  font-size: 0.82rem;
}

.toolbar input, .toolbar select {
  width: 100%;
  padding: 0.8rem 0.95rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(8, 15, 24, 0.9);
  color: var(--text);
}

.stats {
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
}

.stat, .panel {
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 1rem;
  box-shadow: var(--shadow);
}

.stat {
  padding: 1rem 1.1rem;
}

.stat strong {
  display: block;
  margin-top: 0.35rem;
  font-size: 1.5rem;
}

.grid {
  grid-template-columns: minmax(18rem, 24rem) minmax(18rem, 24rem) minmax(0, 1fr);
  align-items: start;
}

.panel {
  padding: 1rem;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 0.9rem;
}

.panel-list, .detail-list, .message-list {
  max-height: 62vh;
  overflow: auto;
}

.card, .detail-card, .message {
  border: 1px solid var(--border);
  border-radius: 0.9rem;
  padding: 0.85rem;
  background: var(--panel-alt);
}

.card button, .toolbar button {
  border: 0;
  border-radius: 999px;
  padding: 0.72rem 1rem;
  font-weight: 600;
  cursor: pointer;
}

.toolbar button, .card button {
  background: rgba(56, 189, 248, 0.18);
  color: var(--text);
}

.toolbar button.primary {
  background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
  color: #07111a;
}

.toolbar button.secondary {
  background: rgba(148, 163, 184, 0.16);
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border-radius: 999px;
  padding: 0.3rem 0.6rem;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  background: rgba(148, 163, 184, 0.14);
  color: var(--muted);
}

.pill.running { color: var(--accent); background: rgba(74, 222, 128, 0.14); }
.pill.failed, .pill.error { color: var(--error); background: rgba(248, 113, 113, 0.14); }
.pill.waiting_for_input { color: var(--warning); background: rgba(251, 191, 36, 0.14); }
.pill.busy, .pill.running-job { color: var(--info); background: rgba(56, 189, 248, 0.14); }

.row {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: center;
}

.meta, .empty {
  color: var(--muted);
  font-size: 0.85rem;
}

.message pre, .card pre {
  margin: 0.5rem 0 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.detail-card h3, .card h3 {
  font-size: 0.95rem;
  margin-bottom: 0.25rem;
}

.urls {
  display: grid;
  gap: 0.5rem;
}

.urls a {
  color: #c7f9d6;
  text-decoration: none;
  word-break: break-all;
}

.urls a:hover {
  text-decoration: underline;
}

.observer-error {
  padding: 2rem;
  color: #fecaca;
  font-family: ui-sans-serif, system-ui, sans-serif;
}

@media (max-width: 1080px) {
  .grid { grid-template-columns: 1fr; }
  .toolbar { grid-template-columns: 1fr; }
  .detail-list, .panel-list, .message-list { max-height: none; }
}`;
