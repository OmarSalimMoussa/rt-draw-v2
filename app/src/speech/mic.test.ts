// v2's mic (src/core/speech.ts) on phones: iPhones only let audio start from the tap itself, and asking for
// the microphone ends the tap, so the audio is set going before the question.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Mic } from "../../../src/core/speech.ts";

let order: string[];
let answer: () => Promise<MediaStream>;
const node = () => ({ connect: (next: unknown) => next, gain: { value: 1 }, port: {} });

beforeEach(() => {
  order = [];
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      destination = node();
      audioWorklet = { addModule: async () => void order.push("worklet") };
      constructor() {
        order.push("audio");
      }
      createGain = node;
      createMediaStreamSource = node;
      close = async () => void order.push("closed");
    },
  );
  vi.stubGlobal("AudioWorkletNode", class { port = {}; connect = (next: unknown) => next; });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => (order.push("microphone"), answer()) } });
});
afterEach(() => vi.unstubAllGlobals());

it("starts the audio before asking for the microphone", async () => {
  answer = async () => ({ getTracks: () => [] }) as unknown as MediaStream;
  await new Mic().start();
  expect(order).toEqual(["audio", "microphone", "worklet"]);
});

it("lets the audio go when the microphone is refused", async () => {
  answer = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
  await expect(new Mic().start()).rejects.toThrow("denied");
  expect(order).toEqual(["audio", "microphone", "closed"]);
});
