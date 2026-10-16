// Who drives the product in a run. A driver knows only what a real person in
// its place would know: the product's blurb, and (for a first-timer) the site
// it has in mind. Never our prompts, ops, knobs or code.

/** What a first-time user is told about the product: the store-page blurb, nothing more. */
export const BLURB = "rt-draw: talk and scribble on a canvas, press Enter, and a hand-drawn wireframe of your website or app appears. Keep talking and drawing to change it.";

/** What a breaker knows: how the product works, as its public docs would say. */
const DOCS = "You know how it works: your words are transcribed with times; each scribble is numbered and tied to the word you were saying as you drew it; at Enter, a model gets your words, a screenshot with your numbered ink, and a list of the shapes on the canvas, and writes edit operations that land on the canvas one by one. Ambiguous ink, vague references and contradictions are where it is weakest.";

export type Persona = { id: string; name: string; who: string; knows: string; wants: string };

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

/** Sites first-timers have in mind: a short picture of each, as a person would remember it. */
export const TARGETS: { id: string; name: string; picture: string }[] = [
  { id: "bakery", name: "A bakery's home page", picture: "a small bakery's home page: the bakery's name and a croissant logo at the top, a big photo of fresh bread, opening hours, three favourite pastries with prices, a map and address at the bottom, an Order button" },
  { id: "airbnb", name: "A holiday rental listing (like Airbnb)", picture: "a listing page for a cabin: a grid of photos at the top, the title and location, the host with a round photo, a list of amenities with icons, and a booking card on the right with the price per night, dates and a Reserve button" },
  { id: "pricing", name: "A pricing page (like Stripe's)", picture: "a pricing page: a headline, three plan cards side by side (Starter, Pro, Enterprise) with price, a list of features and a button each, the middle one highlighted, and FAQs below" },
  { id: "music", name: "A music player (like Spotify)", picture: "a music app screen: a sidebar with Home, Search and playlists on the left, album covers in rows in the middle, and a player bar at the bottom with play, skip and a progress line" },
  { id: "lesson", name: "A language lesson (like Duolingo)", picture: "a phone-sized language lesson: a progress bar at the top, a cartoon character asking a question in a speech bubble, four answer buttons, and a big Check button at the bottom" },
  { id: "dentist", name: "A dentist's booking form", picture: "a dentist's booking page: the clinic's name, a short calendar to pick a day, time slots as buttons, fields for name and phone, and a Book button" },
  { id: "dashboard", name: "A SaaS dashboard", picture: "an analytics dashboard: a top bar with search and an avatar, a left menu, four number cards across the top (users, revenue, churn, signups), a line chart, and a table of recent customers" },
  { id: "repo", name: "A code repository page (like GitHub)", picture: "a code repository page: the repo name and a star button, tabs (Code, Issues, Pull requests), a file list, and the README below with a title and a few paragraphs" },
];
