# rt-draw (aka Imagine)

Talk and doodle, and rt-draw sketches what you mean in a few seconds.

https://github.com/user-attachments/assets/557ccdd4-02e2-417d-b997-eb50f3c1f12e

## What it is

Say or type what you have in mind: a website, a phone app, a diagram, or just a
picture. rt-draw draws a rough, hand-drawn sketch of it on a big sheet of paper
on your screen.

Then you change it the way you would with a person at a whiteboard. Circle a
part, point at it, or scribble over it, and say what you want: "make this
bigger", "add a menu here", "this button goes to the next page". rt-draw changes
just that part.

A rough sketch is the fastest way to show someone an idea before anyone builds
it. rt-draw makes that sketch for you while you talk.

## How it works

An AI model does the drawing. It doesn't paint a picture. It writes
short drawing instructions, one line at a time, like "a box here" or "a label
there". The screen draws each line as soon as it arrives, so the sketch starts
appearing right away instead of all at once at the end.

The AI also sees your marks. When you circle something and say "this", it knows
which thing you mean.

This is the second version. The first one drew plainer web page mockups, and
more slowly.

## It got faster by testing itself

This repo also holds the program that made rt-draw faster: we call it the eval
loop. It ran on its own, day and night, and tried to make rt-draw quicker
without making its drawings worse.

Each round, AI reviewers suggested a few small changes: a setting, a different
way of wording the instructions to the AI, or a bit of code. We added a few
ideas of our own. Every change was tested against the best version so far, on
hundreds of saved example requests, and kept only if it did better.

In about 22 hours of running (19 to 20 October 2026), for a typical request:

| | Before | After |
| --- | --- | --- |
| First change on screen | 5.8 seconds | 2.4 seconds |
| Sketch finished | 7.1 seconds | 3.9 seconds |

The drawings were just as good.

- `evals/` is the loop itself. `evals/README.md` tells the story, with charts,
  and `evals/RUNBOOK.md` explains how to run it.
- The `loop/champion` branch is the best version the loop found.
- The `eval/history` branch is its record of every change it tried, kept or not.

## Try it

rt-draw is online as **imagine** at
[imagine.emberhub.dev](https://imagine.emberhub.dev). It is invite-only for now:
join the waitlist there.

## For developers

rt-draw is built from small parts. Each one was tested on its own test page (a
"playground") before anything was put together. None of these parts need the AI,
so each can be tried without it.

| Playground | What it does | Main files |
| --- | --- | --- |
| `/playgrounds/render/` | draws the scene: shapes in layers, text inside shapes, spaces for pictures, fading, the grid, and the labels the AI uses to name each shape | `src/core/render.ts`, `src/core/scene.ts` |
| `/playgrounds/ops/` | reads the AI's drawing instructions and applies each one as soon as its line is complete | `src/core/ops.ts` |
| `/playgrounds/ink/` | records your pen strokes, with the time of every point | `src/core/ink.ts` |
| `/playgrounds/hittest/` | works out which shapes a stroke touches, circles, starts on and ends on | `src/core/hittest.ts` |
| `/playgrounds/marks/` | groups strokes into marks, decides if each is pointing or a sketch, and checks if it's an arrow (and which end is the tip) | `src/core/marks.ts`, `src/core/arrow.ts` |

```
npm install
npm run dev        # http://localhost:5173
npm run typecheck
```

### The app

`app/` is the product people use: the first version's look and controls on top
of this version's drawing engine. It has a board of pages you draw on and talk
to, your projects, links between pages, and a preview you can click through. It
runs on its own port and uses the same services as the playgrounds: the AI
model, and ElevenLabs Scribe to turn speech into text.

```
cd app && npm install
npm run dev        # http://localhost:5180
npm test
```

To put it online, `scripts/deploy.sh` builds the `Dockerfile` (the page and
`app/server/host.ts` served together on one port) and starts it on our server.
`deploy/README.md` covers invites, the admin page and the mailer.

The design notes are in a separate document, "rt-draw: a canvas the model can
see", which isn't in this repo.

## Credits and license

Borrowed: rough.js (MIT) for the hand-drawn look, perfect-freehand (MIT) for
strokes, rbush (MIT) to find shapes on the page quickly, Excalifont (OFL, see
`src/fonts`).

License: MIT (`LICENSE`). The borrowed parts keep their own licenses.
