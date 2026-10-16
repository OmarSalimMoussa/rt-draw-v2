// Who drives the product in a run. A driver knows only what a real person in
// its place would know: the product's blurb, and (for a first-timer) a loose
// memory of the site it has in mind. Never our prompts, ops, knobs or code.
import type { PersonaId, StartId, StyleId, TargetId } from "../loop/types.ts";

/** What a first-time user is told about the product: the store-page blurb, nothing more. */
export const BLURB = "rt-draw: talk and scribble on an infinite board of pages, press Enter, and hand-drawn wireframes of your website or app appear. Keep talking and drawing to change them; ask it to show you a page and it takes you there.";

/** What a breaker knows: how the product works, as its public docs would say. */
const DOCS = "You know how it works: your words are transcribed with times; each scribble is numbered and tied to the word you were saying as you drew it; at Enter, a model gets your words, several pictures of the board (what your screen shows with your numbered ink, close-ups of your marks, pages you named) and a site map listing the board's pages and shapes, then writes edit operations that land on the board one by one, and can move your screen. Ambiguous ink, vague references and contradictions are where it is weakest.";

export type Persona = { id: PersonaId; name: string; who: string; knows: string; wants: string };

export const PERSONAS: Persona[] = [
  {
    id: "first-timer",
    name: "First-timer with a site in mind",
    who: "a first-time user with a website or app idea in mind. You have never used a tool like this. You are not a designer; you describe things by how they look and what they are for (\"the blue bit\", \"a box for the photo\").",
    knows: BLURB,
    wants: "to get a page that looks like the one you have in mind. You reveal it bit by bit, the way people do, not as a spec.",
  },
  {
    id: "explorer",
    name: "Clueless explorer",
    who: "someone who found this tool and is poking at it with no particular goal. You try things to see what happens, sometimes odd things, and drop ideas halfway.",
    knows: BLURB,
    wants: "to see what it can do. You follow whatever catches your eye.",
  },
  {
    id: "breaker",
    name: "Breaker",
    who: "a tester who knows the product and wants to make it fail, while still sounding like a real user, never like a test script.",
    knows: `${BLURB} ${DOCS}`,
    wants: "to find where it breaks: ambiguous arrows and shapes, \"this\" with two candidates nearby, contradictions in one breath, changing your mind across sends, huge asks then toning them down, strange asks.",
  },
];
export const personaOf = (id: PersonaId) => PERSONAS.find((p) => p.id === id)!;

/**
 * Sites first-timers have in mind. `memory` is all the driver gets: a loose recollection
 * in a person's words (drivers-m3: given the part list, first-timers recited it). `parts`
 * is the precise list, for the judges only. Held-out targets never appear in a tuning session.
 */
export type Target = { id: TargetId; name: string; memory: string; parts: string; heldOut: boolean };

export const TARGETS: Target[] = [
  { id: "bakery", name: "A bakery's home page", heldOut: false, memory: "the site of that little bakery you like: their name up top, a big photo of bread, the opening hours somewhere, a few pastries, a little map at the bottom, and a way to order", parts: "a small bakery's home page: the bakery's name and a croissant logo at the top, a big photo of fresh bread, opening hours, three favourite pastries with prices, a map and address at the bottom, an Order button" },
  { id: "airbnb", name: "A holiday rental listing (like Airbnb)", heldOut: false, memory: "a holiday cabin listing like on Airbnb: lots of photos at the top, who the host is, what the place has, and the price with a button to reserve off to the side", parts: "a listing page for a cabin: a grid of photos at the top, the title and location, the host with a round photo, a list of amenities with icons, and a booking card on the right with the price per night, dates and a Reserve button" },
  { id: "pricing", name: "A pricing page (like Stripe's)", heldOut: false, memory: "a pricing page like Stripe's: three plans next to each other, the middle one stands out, and some questions underneath", parts: "a pricing page: a headline, three plan cards side by side (Starter, Pro, Enterprise) with price, a list of features and a button each, the middle one highlighted, and FAQs below" },
  { id: "music", name: "A music player (like Spotify)", heldOut: false, memory: "a music app like Spotify: a menu down the left, album covers in rows, and the play controls along the bottom", parts: "a music app screen: a sidebar with Home, Search and playlists on the left, album covers in rows in the middle, and a player bar at the bottom with play, skip and a progress line" },
  { id: "lesson", name: "A language lesson (like Duolingo)", heldOut: true, memory: "a language lesson like Duolingo on a phone: how far along you are at the top, a little cartoon character asks you something, you tap one of a few answers, and there's a big button at the bottom", parts: "a phone-sized language lesson: a progress bar at the top, a cartoon character asking a question in a speech bubble, four answer buttons, and a big Check button at the bottom" },
  { id: "dentist", name: "A dentist's booking form", heldOut: false, memory: "your dentist's booking page: you pick a day, pick a time, put in your name and phone, and book", parts: "a dentist's booking page: the clinic's name, a short calendar to pick a day, time slots as buttons, fields for name and phone, and a Book button" },
  { id: "dashboard", name: "A SaaS dashboard", heldOut: false, memory: "one of those business dashboards: a few big numbers across the top, a chart, a table of customers, a menu on the side", parts: "an analytics dashboard: a top bar with search and an avatar, a left menu, four number cards across the top (users, revenue, churn, signups), a line chart, and a table of recent customers" },
  { id: "repo", name: "A code repository page (like GitHub)", heldOut: false, memory: "a project page on GitHub: the name and a star button, some tabs, the list of files, and the readme underneath", parts: "a code repository page: the repo name and a star button, tabs (Code, Issues, Pull requests), a file list, and the README below with a title and a few paragraphs" },
  { id: "notion", name: "A notes page (like Notion)", heldOut: true, memory: "a notes page like Notion: your pages listed down the left, and the page itself with a picture across the top, a little emoji, a big title and some checklists", parts: "a notes app page: a left sidebar with the workspace name, a search and a tree of pages; the page with a cover image, an emoji icon, a big title, then blocks: a heading, a checklist of to-dos, a two-column table and a paragraph of text" },
  { id: "uber", name: "A ride-booking screen (like Uber)", heldOut: true, memory: "the ride app screen like Uber: a big map, where-to at the top, and a list of cars with prices to pick from at the bottom", parts: "a phone ride-booking screen: a full-screen map with the route, a 'Where to?' search box at the top, and a bottom sheet listing ride options (UberX, Comfort, XL) with a car picture, price and arrival time each, and a big Confirm button" },
];
export const targetOf = (id: TargetId) => TARGETS.find((t) => t.id === id)!;

/** How a person talks and draws, as presets of the driver's traits (each 0 to 1). */
export type Style = { mess: number; disfluency: number; words: number; clarity: number; pen: number; patience: number; changeMind: number; bigThenSmall: boolean };

export const STYLES: { id: StyleId; name: string; style: Style }[] = [
  { id: "typical", name: "Typical: says it and points sometimes", style: { mess: 0.5, disfluency: 0.5, words: 0.5, clarity: 0.5, pen: 0.5, patience: 0.5, changeMind: 0.3, bigThenSmall: false } },
  { id: "pointer", name: "Pointer: few words, all marker", style: { mess: 0.6, disfluency: 0.2, words: 0, clarity: 0.2, pen: 1, patience: 0.5, changeMind: 0.3, bigThenSmall: false } },
  { id: "talker", name: "Vague talker: avoids the marker", style: { mess: 0.6, disfluency: 0.7, words: 0.6, clarity: 0.1, pen: 0, patience: 0.6, changeMind: 0.4, bigThenSmall: false } },
  { id: "precise", name: "Precise: names everything", style: { mess: 0.3, disfluency: 0.2, words: 0.7, clarity: 1, pen: 0.4, patience: 0.7, changeMind: 0.1, bigThenSmall: false } },
  { id: "rambler", name: "Rambler: talks a lot, changes their mind", style: { mess: 0.7, disfluency: 0.9, words: 1, clarity: 0.4, pen: 0.4, patience: 0.4, changeMind: 0.9, bigThenSmall: true } },
];
export const styleOf = (id: StyleId) => STYLES.find((s) => s.id === id)!.style;

/** Below this, a person barely uses the marker: no ink beats, and no pen lines in their message (drivers-9). */
export const PEN_MIN = 0.34;

/**
 * Coherent combinations (§2.2, drivers-9), drawn from this table, never as independent
 * traits. First-timers also start on `resume:<own target>` (refreshes only). Held-out
 * starts are never used by a tuning session; site:<target> is a held-out first-timer's page.
 */
export const COHERENT: Record<PersonaId, { styles: StyleId[]; starts: StartId[]; heldOutStarts: StartId[] }> = {
  "first-timer": { styles: ["typical", "pointer", "talker", "precise", "rambler"], starts: ["blank"], heldOutStarts: ["blank"] },
  explorer: { styles: ["typical", "pointer", "rambler", "talker"], starts: ["toyshop-home", "toyshop-products", "toyshop-zoomed-out", "clowns", "messy", "blank"], heldOutStarts: ["grid", "messy-zoomed-out", "toyshop-cart", "site:notion", "site:uber", "site:lesson"] },
  breaker: { styles: ["typical", "precise", "pointer"], starts: ["toyshop-home", "toyshop-products", "toyshop-zoomed-out", "clowns", "messy"], heldOutStarts: ["grid", "messy-zoomed-out", "toyshop-cart", "site:notion", "site:uber", "site:lesson"] },
};

/** A style drawn from a seed, every trait anywhere from 0 to 1 (to a tenth), for the demo page's "random". */
export function randomStyle(next: () => number): Style {
  const x = () => Math.round(next() * 10) / 10;
  return { mess: x(), disfluency: x(), words: x(), clarity: x(), pen: x(), patience: x(), changeMind: x(), bigThenSmall: next() < 0.25 };
}
