// The editor: draw and talk (or type) on v2's board and watch the model draw
// back. The sidebar has the project, its pages and its history; the bar at the
// bottom takes what you say. (v1's App.tsx; the board itself comes next.)
import { useMemo, useState, useSyncExternalStore } from "react";
import { Board } from "./board/board.ts";
import type { SendStatus } from "./board/sender.ts";
import { SettingsMenu } from "./SettingsMenu.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { Icon } from "./sketch/Icon.tsx";

const IDLE: SendStatus = { running: false, queued: 0, ops: 0, settling: false, done: false, rejected: 0 };

/** `hidden`: another page is showing over it (Root.tsx); it keeps working but ignores the keyboard. */
export function App({ hidden = false }: { hidden?: boolean }) {
  void hidden;
  const board = useMemo(() => new Board(), []);
  const empty = useSyncExternalStore(board.subscribe, board.isEmpty);
  const [prompt, setPrompt] = useState("");

  return (
    <div className="pg">
      <div className="cv" />
      <StatusBadge status={IDLE} />
      <div className="pg-tools">
        <button type="button" className="pg-tool" onClick={() => board.newProject()} disabled={empty} title="New project: start from scratch (this one stays in your projects)" aria-label="New project">
          <Icon name="newProject" size={18} />
        </button>
        <a className="pg-tool" href="/projects" title="All your projects" aria-label="All your projects">
          <Icon name="projects" size={18} />
        </a>
        <SettingsMenu />
      </div>
      <aside className="pg-panel">
        <Sidebar board={board} busy={false} onPage={() => {}} onAll={() => {}} />
      </aside>
      <form className="pg-bar" onSubmit={(e) => e.preventDefault()}>
        <div className="pg-row">
          <textarea value={prompt} rows={2} placeholder="Think out loud about your page, e.g. “a landing page for rubber ducks, big yellow hero with a duck photo…”" onChange={(e) => setPrompt(e.target.value)} />
          <button type="button" className="pg-mic" title="Talk" aria-label="Talk">
            <Icon name="mic" size={20} />
          </button>
          <button type="submit" className="pg-send" disabled>Send</button>
        </div>
      </form>
    </div>
  );
}
