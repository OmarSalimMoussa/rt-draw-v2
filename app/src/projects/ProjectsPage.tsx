// All your projects (/projects): each board with a picture of its pages, to
// open, preview, rename or delete. (v1's ProjectsPage.tsx: the thumbnail is v2's
// renderer, and there is no session log.)
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { boardBounds, fitView, pagesOf, union } from "../../../src/core/board.ts";
import { render } from "../../../src/core/render.ts";
import { Scene, type SceneJSON } from "../../../src/core/scene.ts";
import { navigate } from "../router.ts";
import { Logo } from "../sketch/Logo.tsx";
import { type ProjectMeta, SAVED_EVENT, ago, createProject, deleteProject, latestDoc, listProjects, loadIndex, renameProject } from "./storage.ts";
import "./projects.css";

/** Where a project opens. */
const editorOf = (id: string) => `/?p=${id}`;

/** The board's pages, shrunk to a card. */
export function Thumb({ doc }: { doc: SceneJSON }) {
  const svg = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    const scene = Scene.fromJSON(doc);
    const pages = pagesOf(scene);
    render(svg.current!, scene, { view: fitView(pages.length ? union(pages.map((p) => p.box)) : boardBounds(scene), 0.03) });
  }, [doc]);
  return (
    <div className="px-thumb" aria-hidden>
      <svg ref={svg} preserveAspectRatio="xMidYMid slice" />
    </div>
  );
}

function ProjectCard({ p, onChange }: { p: ProjectMeta; onChange: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const open = editorOf(p.id);
  return (
    <li className="px-card">
      <a href={open} title="Open">
        <Thumb doc={latestDoc(p.id)} />
      </a>
      {renaming ? (
        <input
          autoFocus
          defaultValue={p.name}
          aria-label="Project name"
          onBlur={(e) => {
            renameProject(p.id, e.currentTarget.value);
            setRenaming(false);
            onChange();
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      ) : (
        <button type="button" className="px-name" onClick={() => setRenaming(true)} title="Rename">
          {p.name}
        </button>
      )}
      <div className="px-meta">
        {p.pages} {p.pages === 1 ? "page" : "pages"} · {p.versions} versions · {ago(p.updatedAt)}
      </div>
      <div className="px-actions">
        <a className="px-open" href={open}>Open</a>
        <a href={`${open}#preview`} title="Click through the site as a visitor would">Preview</a>
        {confirming ? (
          <>
            <button type="button" className="px-danger" onClick={() => (deleteProject(p.id), onChange())}>Delete it</button>
            <button type="button" onClick={() => setConfirming(false)}>Keep</button>
          </>
        ) : (
          <button type="button" className="px-delete" onClick={() => setConfirming(true)}>Delete</button>
        )}
      </div>
    </li>
  );
}

export function Projects() {
  const [, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    document.title = "Projects · rt-draw";
    addEventListener(SAVED_EVENT, refresh); // this tab's editor, or another tab, saved
    void loadIndex().finally(refresh);
    return () => removeEventListener(SAVED_EVENT, refresh);
  }, []);

  const projects = listProjects();
  return (
    <div className="px">
      <header className="px-top">
        <h1><Logo size={38} /> Projects</h1>
        <nav>
          <a href="/">Editor</a>
        </nav>
      </header>
      <section className="px-section">
        <div className="px-section-head">
          <h2>Your boards</h2>
          <button type="button" onClick={() => navigate(editorOf(createProject().id))}>New project</button>
        </div>
        {projects.length ? (
          <ul className="px-grid">
            {projects.map((p) => <ProjectCard key={p.id} p={p} onChange={refresh} />)}
          </ul>
        ) : (
          <p className="px-empty">No projects yet.</p>
        )}
      </section>
    </div>
  );
}
