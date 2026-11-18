import {
  summaryArgs,
  summaryChoice,
  summaryJoin,
  summaryValue,
  summaryWords,
  type ToolCallSummary,
} from "./compat/tool-call-summary.js";

const ACTIONS = "resize crop convert optimize trim rotate flip blur sharpen composite greyscale modulate contrast gamma tint normalize negate clahe threshold median extend extract_channel remove_alpha unflatten text svg_render affine tile metadata frames spritesheet_to_gif info";

const imageProcessSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  const action = summaryChoice(args.action, ACTIONS);
  const operationMap: Record<string, string> = {
    info: "inspect image",
    metadata: "read image metadata",
    text: "add text to image",
    svg_render: "render SVG",
    spritesheet_to_gif: "convert spritesheet to GIF",
    clahe: "enhance local image contrast",
  };
  const operation = operationMap[action] ?? (action ? `${summaryWords(action)} image` : "process image");
  const source = summaryValue(args.input);
  const target = summaryValue(args.output);
  const pathText = source ? (target ? `${source} → ${target}` : source) : target;
  return summaryJoin(operation, pathText);
};

export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  image_process: imageProcessSummary,
});
