export type Event = (string | number | boolean)[];
const fail = (s: string): never => {
  throw new Error(s);
};
const finite = (v: unknown, lo: number, hi: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
export function textEvents(text: string): Event[] {
  if (!text.length || text.length > 1024 || /[^\x09\x0a\x20-\x7e]/.test(text))
    fail("Text must contain 1–1024 ASCII characters (tab/newline allowed).");
  return Array.from({ length: Math.ceil(text.length / 30) }, (_, i) => [
    ["text", text.slice(i * 30, i * 30 + 30)],
    ["delay", 1000],
  ]).flat() as Event[];
}
export function combo(keys: string[]): Event[] {
  return [
    ...keys.map((k) => ["keyboard", k, true]),
    ["delay", 80],
    ...keys.toReversed().map((k) => ["keyboard", k, false]),
  ] as Event[];
}
export function click(x: number, y: number): Event[] {
  return [
    ["mouse_abs", 1, x, y, 0, 0],
    ["delay", 80],
    ["mouse_abs", 0, x, y, 0, 0],
  ];
}
export function validate(payload: unknown): { events: Event[] } {
  const events = (payload as any)?.events;
  if (!Array.isArray(events) || !events.length || events.length > 256)
    fail("Expected 1–256 events.");
  let delay = 0,
    chars = 0,
    buttons = 0;
  const held = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!Array.isArray(e)) fail("Each event must be an array.");
    switch (e[0]) {
      case "keyboard": {
        if (
          e.length !== 3 ||
          typeof e[1] !== "string" ||
          !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(e[1]) ||
          typeof e[2] !== "boolean"
        )
          fail("Invalid keyboard event.");
        if (e[2]) {
          if (held.has(e[1])) fail("Duplicate key-down.");
          held.add(e[1]);
        } else {
          if (!held.delete(e[1])) fail("Key-up without matching key-down.");
        }
        break;
      }
      case "mouse_abs":
      case "mouse_rel": {
        const absolute = e[0] === "mouse_abs";
        if (
          e.length !== 6 ||
          !Number.isInteger(e[1]) ||
          !finite(e[1], 0, 7) ||
          !finite(e[2], absolute ? 0 : -32767, absolute ? 1 : 32767) ||
          !finite(e[3], absolute ? 0 : -32767, absolute ? 1 : 32767) ||
          !Number.isInteger(e[4]) ||
          !Number.isInteger(e[5]) ||
          !finite(e[4], -20, 20) ||
          !finite(e[5], -20, 20)
        )
          fail("Invalid mouse event.");
        buttons = e[1];
        break;
      }
      case "text": {
        if (
          e.length !== 2 ||
          typeof e[1] !== "string" ||
          !e[1].length ||
          e[1].length > 30 ||
          /[^\x09\x0a\x20-\x7e]/.test(e[1])
        )
          fail(
            "Text events require 1–30 ASCII characters; use the text command to chunk.",
          );
        chars += e[1].length;
        if (
          events[i + 1]?.[0] !== "delay" ||
          !finite(events[i + 1]?.[1], 1000, 5000)
        )
          fail("Text must be followed by a delay of at least 1000ms.");
        break;
      }
      case "delay":
        if (e.length !== 2 || !Number.isInteger(e[1]) || !finite(e[1], 0, 5000))
          fail("Delay must be 0–5000 integer ms.");
        delay += e[1];
        break;
      default:
        fail("Unsupported event type.");
    }
  }
  if (held.size || buttons)
    fail("Batch must release all pressed keys and mouse buttons.");
  if (delay > 60000 || chars > 1024)
    fail("Batch exceeds 60 seconds delay or 1024 text characters.");
  return { events };
}
