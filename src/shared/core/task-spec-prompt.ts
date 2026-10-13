export type TaskSpecPromptInput = {
  taskId: string;
  baseSha: string;
  request: string;
  contextPaths?: string[];
  allowedPaths?: string[];
  testCommands?: string[];
};

/** Builds the stable, explicit contract given to the Architect. */
export const buildTaskSpecPrompt = (input: TaskSpecPromptInput): string => {
  const context = input.contextPaths;
  const allowed = input.allowedPaths;
  const tests = input.testCommands;
  return [
    "Create a TaskSpec JSON for this task.",
    `task_id MUST be exactly: ${input.taskId}`,
    `base_sha MUST be exactly: ${input.baseSha}`,
    context ? `context_paths are read-only context paths; use only these paths: ${JSON.stringify(context)}` : "context_paths are read-only; choose safe repository-relative context paths from the request and repository context.",
    allowed ? `scope.allowed_paths is the future write scope; use only these paths: ${JSON.stringify(allowed)}` : "scope.allowed_paths is the future write scope; choose at least one minimal safe repository-relative write scope from the request.",
    tests ? `test_commands are declarations for the platform to execute later; do not execute them: ${JSON.stringify(tests)}` : "test_commands are structured platform-owned declarations for the platform to execute later; do not execute them.",
    "Do not modify files, run commands, or infer a different task identity.",
    `User request:\n${input.request}`
  ].join("\n");
};
