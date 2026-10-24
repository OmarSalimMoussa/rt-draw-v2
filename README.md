# rt-draw v2

A doodle-style canvas the model can see: free-form shapes in layers, a small
line-based op language, and your voice and ink linked to what's on screen.
Design notes: the Claude Doc "rt-draw: a canvas the model can see".



https://github.com/user-attachments/assets/557ccdd4-02e2-417d-b997-eb50f3c1f12e



v2 is built from small parts, each tested alone in a playground before
anything is assembled. None of them call a model.

| Playground | Part | Core file |
| --- | --- | --- |
| `/playgrounds/render/` | renderer: layered shapes, text inside shapes, picture placeholders, fade, grid, id tags | `src/core/render.ts`, `src/core/scene.ts` |
| `/playgrounds/ops/` | op parser and stream: applies each op as its line completes | `src/core/ops.ts` |
| `/playgrounds/ink/` | ink capture with a time on every point | `src/core/ink.ts` |
| `/playgrounds/hittest/` | which shapes a stroke touches, encloses, starts and ends on | `src/core/hittest.ts` |
| `/playgrounds/marks/` | strokes grouped into marks, read as pointing or sketch; each also checked for being an arrow (tip and tail) | `src/core/marks.ts`, `src/core/arrow.ts` |

```
npm install
npm run dev        # http://localhost:5173
npm run typecheck
```

## The app

`app/` is the product: v1's UI on v2's engine (a board of pages you draw on and
talk to, the projects, links and the preview). It runs on its own port, with the
same model and Scribe routes as the playgrounds:

```
cd app && npm install
npm run dev        # http://localhost:5180
npm test
```

It is hosted as **imagine** at imagine.emberhub.dev, in v1's place, open to people
with an invite: `scripts/deploy.sh` builds the `Dockerfile` (the page and
`app/server/host.ts` on one port) and starts it on the ember box.
`deploy/README.md` covers invites, the admin page and the mailer.

Borrowed: rough.js (MIT) for the hand-drawn look, perfect-freehand (MIT) for
strokes, rbush (MIT) for the spatial index, Excalifont (OFL, see `src/fonts`).

License: MIT (`LICENSE`). The borrowed parts keep their own licenses.
