// The left sidebar: the project (rename it), its pages (each nested under the
// page whose link leads to it) and its history, where you can look back and
// restore an old board without losing anything. (v1's page/Sidebar.tsx, with its
// hover fix, on v2's pages; no preview.)
import { useState, useSyncExternalStore } from "react";
import type { Board } from "./board/board.ts";
import { pageRows } from "./board/pages.ts";
import { ago } from "./projects/storage.ts";
import { Icon } from "./sketch/Icon.tsx";
import { Logo } from "./sketch/Logo.tsx";

type Props = {
  board: Board;
  /** A send is running or queued: the board can't be restored under it. */
  busy: boolean;
  /** Glide to a page. */
  onPage(id: string): void;
  /** Fit every page in view. */
  onAll(): void;
};

export function Sidebar({ board, busy, onPage, onAll }: Props) {
  useSyncExternalStore(board.subscribe, board.getVersion);
  const h = board.history;
  // A hovered version shows on the canvas only: above the history the sidebar keeps the latest pages, and the
  // bar to restore a version comes with a click. If either changed size under the pointer, the rows would move,
  // another version would land under it and change them back, and the rows would flicker.
  const looked = h.pinned ? h.looking : undefined;
  const pages = pageRows(looked === undefined ? board.scene : board.shown());
  const [picked, setPicked] = useState<string>();
  const history = h.newestFirst();
  const latest = h.latest();
  const [renaming, setRenaming] = useState(false);
  const name = board.meta()?.name ?? "Untitled";

  return (
    <div className="lp-panel" onMouseLeave={() => board.look(undefined)}>
      <div className="lp-project">
        <Logo size={26} />
        {renaming ? (
          <input
            autoFocus
            defaultValue={name}
            aria-label="Project name"
            onBlur={(e) => {
              board.rename(e.currentTarget.value);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <button type="button" className="lp-name" onClick={() => setRenaming(true)} title="Rename this project">
            {name}
          </button>
        )}
      </div>
      <div className="lp-head">
        <span>Pages</span>
      </div>
      <ul className="lp-tree">
        <li>
          <button type="button" className={picked ? "" : "on"} onClick={() => (setPicked(undefined), onAll())}>
            All pages
          </button>
        </li>
        {pages.map((p) => (
          <li key={p.id} style={{ paddingLeft: p.depth * 14 }}>
            <button type="button" className={p.id === picked ? "on" : ""} onClick={() => (setPicked(p.id), onPage(p.id))}>
              <span className="lp-glyph" aria-hidden>{p.home ? <Icon name="home" /> : <Icon name="branch" />}</span>
              <span className="lp-label">{p.name}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="lp-head">
        <span>History</span>
      </div>
      {looked !== undefined && (
        <div className="lp-looking">
          <span>Viewing V{looked}</span>
          <button type="button" className="lp-restore" disabled={busy} onClick={() => board.restore(looked)} title={busy ? "Wait for the drawing to finish" : undefined}>
            Restore
          </button>
          <button type="button" onClick={() => board.stopLooking()}>Latest</button>
        </div>
      )}
      {history.length === 0 ? (
        <p className="lp-empty">Nothing yet. Start talking and every change shows up here.</p>
      ) : (
        <ol className="lp-history">
          {history.slice(0, 80).map((v) => (
            <li key={v.n}>
              <button
                type="button"
                className={v.n === (h.looking ?? latest) ? "on" : ""}
                onMouseEnter={() => board.look(v.n)}
                onClick={() => board.look(v.n, true)}
                title={v.label}
              >
                <span className="lp-n">V{v.n}</span>
                <span className="lp-label">{v.label}</span>
                <span className="lp-ago">{v.n === latest ? "latest" : ago(v.at)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
