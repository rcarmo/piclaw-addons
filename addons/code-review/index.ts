import { createCodeReviewTool } from "./tool.js";
export { createCodeReviewTool, codeReviewToolDeclaration } from "./tool.js";
export { setReviewDatabaseSource, reviewService, closeReviewServices } from "./runtime.js";
export default function codeReview(pi: any) {
  pi.registerTool(createCodeReviewTool());
  pi.on("resources_discover", () => ({
    skillPaths: [`${import.meta.dir}/skills/code-review`],
  }));
}
