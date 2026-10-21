// Latency spans with OpenTelemetry: span ids, timing, nesting, attributes and
// events come from the SDK, kept in memory for the Latency modal (and
// exportable to Jaeger or Honeycomb later by adding an exporter here).
//
// One thing the SDK can't do in a browser: carry the current span across
// `await` by itself (its zone.js context manager doesn't follow native
// async/await). So the parent is passed explicitly: span(name, parent, fn) gives
// fn its own context to hand to the steps inside it.
import { type Attributes, type Context, ROOT_CONTEXT, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

export type { Context as TraceContext };
export type { ReadableSpan };

/** Fired on window whenever a span ends. */
export const TRACES_EVENT = "rt-traces";

const exporter = new InMemorySpanExporter();
const notify: SpanProcessor = {
  onStart: () => window.dispatchEvent(new Event(TRACES_EVENT)),
  onEnd: () => window.dispatchEvent(new Event(TRACES_EVENT)),
  forceFlush: async () => {},
  shutdown: async () => {},
};
// Not registered globally: the pages' spans stay in this provider.
const provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter), notify] });
const tracer = provider.getTracer("rt-draw");

/** Spans still running, so the modal can draw them growing. */
export const open = new Map<string, { span: Span; name: string; traceId: string; parentId?: string; start: number }>();

/**
 * Runs fn inside a span named `name`, a child of `parent` (a new trace when
 * there is none). fn gets the span's context to pass to the steps inside it.
 */
export async function span<T>(name: string, parent: Context | undefined, fn: (ctx: Context, s: Span) => T | Promise<T>, attrs?: Attributes): Promise<T> {
  const s = tracer.startSpan(name, { attributes: attrs }, parent ?? ROOT_CONTEXT);
  const sc = s.spanContext();
  const parentId = parent ? trace.getSpan(parent)?.spanContext().spanId : undefined;
  open.set(sc.spanId, { span: s, name, traceId: sc.traceId, parentId, start: performance.now() });
  try {
    return await fn(trace.setSpan(parent ?? ROOT_CONTEXT, s), s);
  } catch (err) {
    s.recordException(err as Error);
    s.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    open.delete(sc.spanId);
    s.end();
  }
}

/** The same for synchronous steps (rendering, parsing). */
export function spanSync<T>(name: string, parent: Context | undefined, fn: (ctx: Context, s: Span) => T, attrs?: Attributes): T {
  const s = tracer.startSpan(name, { attributes: attrs }, parent ?? ROOT_CONTEXT);
  try {
    return fn(trace.setSpan(parent ?? ROOT_CONTEXT, s), s);
  } finally {
    s.end();
  }
}

/** A finished child span from times measured elsewhere (e.g. the server's stats), in performance.now() ms. */
export function timed(parent: Context | undefined, name: string, start: number, end: number, attrs?: Attributes) {
  if (!parent || !(end >= start)) return;
  tracer.startSpan(name, { startTime: start, attributes: attrs }, parent).end(end);
}

/** A moment inside the current span: "first op applied", "first text". */
export const mark = (ctx: Context | undefined, name: string, attrs?: Attributes) => ctx && trace.getSpan(ctx)?.addEvent(name, attrs);

/** Every finished span so far. */
export const finished = (): ReadableSpan[] => exporter.getFinishedSpans();

/**
 * Keeps only the finished spans that started at or after `ms` (performance.now() ms), for a page that stays open.
 * A span's start read back on the page clock can come out a few µs early, hence the 1 ms of slack (as the eval's bridge allows).
 */
export function forgetSpansBefore(ms: number) {
  const kept = exporter.getFinishedSpans().filter((s) => s.startTime[0] * 1000 + s.startTime[1] / 1e6 - performance.timeOrigin >= ms - 1);
  exporter.reset();
  if (kept.length) exporter.export(kept, () => {});
}
