// What imagine can do that nobody guesses from a text box: the tour once, a first drawing one tap
// away, and then one move to try at a time, until each has been tried (or waved off). All of it is
// remembered in this browser only; none of it is internal, so testers see it too.

const TOUR_KEY = "rt-draw.tour";
const TIPS_KEY = "rt-draw.tips";

/** First drawings that show how far it goes, each with a doodle from public/doodles. */
export const STARTERS = [
  {
    label: "A bakery website",
    doodle: "croissant",
    prompt: "A website for a small neighbourhood bakery: a warm hero with a photo of fresh bread, today's bakes as cards with prices, opening hours and how to find us",
  },
  {
    label: "A phone app",
    doodle: "coffee",
    prompt: "A phone app for ordering coffee ahead: pick a drink, choose the size and milk, and see when it'll be ready to pick up",
  },
  {
    label: "A macOS desktop",
    doodle: "plane",
    prompt: "A whole macOS desktop: the menu bar, the dock, a Finder window open on a folder of holiday photos, and a Notes window with a packing list",
  },
  {
    label: "A system diagram",
    doodle: "bulb",
    prompt: "A system diagram of how a food delivery app works: the customer's phone, the API, the orders database, payments, the restaurant's tablet and the courier's app, with arrows for what goes where",
  },
  {
    label: "A drawing",
    doodle: "cat",
    prompt: "A drawing of a cat asleep on a pile of books by a window, with the moon outside",
  },
] as const;

export type TipId = "circle" | "page" | "preview" | "talk" | "arrow";
/** The moves, in the order they're suggested: each is checked off the first time it's done. */
export const TIPS: { id: TipId; text: string }[] = [
  { id: "circle", text: "Draw a circle around something on your page, then say or type what to change, like “make this blue”." },
  { id: "page", text: "Ask for another screen: “add a Menu page”, or “now the phone app for it”." },
  { id: "preview", text: "Press Preview on the left, then click any button on your page: imagine builds the page it opens." },
  { id: "talk", text: "Tap the mic and talk while you draw: “put this here, and make that one bigger”." },
  { id: "arrow", text: "Draw an arrow from something to where it should go, then press Send." },
];

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};

export const tourSeen = () => read(TOUR_KEY) === "done";
export const seeTour = () => write(TOUR_KEY, "done");

/** The moves tried (or waved off) in this browser. */
export function tipsDone(): Set<TipId> {
  try {
    const ids = JSON.parse(read(TIPS_KEY) ?? "[]");
    return new Set(Array.isArray(ids) ? ids.filter((id): id is TipId => TIPS.some((t) => t.id === id)) : []);
  } catch {
    return new Set();
  }
}
/** Checks a move off, for good. */
export const doneTip = (id: TipId) => write(TIPS_KEY, JSON.stringify([...tipsDone().add(id)]));

/** The next move to suggest, if any is left. */
export const nextTip = (done: Set<TipId>) => TIPS.find((t) => !done.has(t.id));
