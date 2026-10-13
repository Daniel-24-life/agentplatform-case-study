export type AllowedPhase = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type ScaffoldStatus = "pending" | "ready" | "blocked";

export type ProjectSnapshot = {
  repoPath: string;
  baseSha: string;
  branch: string;
  clean: boolean;
};
