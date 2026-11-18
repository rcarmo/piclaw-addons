import {
  summaryArgs,
  summaryFields,
  summaryJoin,
  summaryValue,
  type ToolCallSummary,
} from "./compat/tool-call-summary.js";

const winListWindowsSummary: ToolCallSummary = () => "list windows";
const winListMonitorsSummary: ToolCallSummary = () => "list monitors";

const winScreenshotSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  return summaryJoin("capture window", summaryFields(args, "titleMatch", "outPath"));
};

const winDesktopScreenshotSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  return summaryJoin("capture desktop", summaryValue(args.outPath));
};

const winMonitorScreenshotSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  return summaryJoin("capture monitor", summaryFields(args, "monitorIndex", "deviceName", "outPath"));
};

const winRegionScreenshotSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  return summaryJoin("capture screen region", summaryValue(args.outPath));
};

const winFindElementsSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  return summaryJoin("find window elements", summaryFields(args, "windowTitle", "elementName"));
};

const winClickSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  return summaryJoin("click window element", summaryFields(args, "windowTitle", "elementName"));
};

const winTypeSummary: ToolCallSummary = () => "type text";

const winTreeSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  return summaryJoin("inspect window elements", summaryValue(args.windowTitle));
};

const winKillSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  const action = typeof args.force === "boolean" && args.force ? "force close window" : "close window";
  return summaryJoin(action, summaryValue(args.titleMatch));
};

export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  win_list_windows: winListWindowsSummary,
  win_screenshot: winScreenshotSummary,
  win_desktop_screenshot: winDesktopScreenshotSummary,
  win_list_monitors: winListMonitorsSummary,
  win_monitor_screenshot: winMonitorScreenshotSummary,
  win_region_screenshot: winRegionScreenshotSummary,
  win_find_elements: winFindElementsSummary,
  win_click: winClickSummary,
  win_type: winTypeSummary,
  win_tree: winTreeSummary,
  win_kill: winKillSummary,
});
