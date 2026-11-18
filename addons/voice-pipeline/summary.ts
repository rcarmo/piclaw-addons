import {
  summaryArgs,
  summaryChoice,
  summaryJoin,
  summaryValue,
  type ToolCallSummary,
} from "./compat/tool-call-summary.js";

const ACTIONS = "announce play pause stop mute unmute volume scene wake sensors entities snapshot subtitle";

const avaSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  const action = summaryChoice(args.command, ACTIONS);
  const operationMap: Record<string, string> = {
    announce: "announce text",
    play: "play media",
    pause: "pause media",
    stop: "stop playback",
    mute: "mute device",
    unmute: "unmute device",
    volume: "set volume",
    scene: "show scene",
    wake: "wake display",
    sensors: "read sensors",
    entities: "list device entities",
    snapshot: "capture camera image",
    subtitle: "set subtitle",
  };
  return summaryJoin(operationMap[action] ?? "control ThinkSmart",
    action === "scene" ? summaryValue(args.scene) : action === "volume" && typeof args.level === "number" ? summaryValue(args.level) : null);
};

export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  ava: avaSummary,
});
