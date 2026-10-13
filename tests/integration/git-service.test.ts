import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach,describe,expect,it } from "vitest";
import { GitService } from "../../src/main/git/git-service.js";

const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
const git=(cwd:string,...args:string[])=>execFileSync("git",args,{cwd,encoding:"utf8"}).trim();
const fixture=()=>{const root=mkdtempSync(path.join(os.tmpdir(),"agentplatform-git-"));roots.push(root);const repo=path.join(root,"repo");const managed=path.join(root,"managed");mkdirSync(repo);git(repo,"init");git(repo,"config","user.email","test@example.invalid");git(repo,"config","user.name","AgentPlatform Test");writeFileSync(path.join(repo,"README.md"),"base\n");git(repo,"add","README.md");git(repo,"commit","-m","base");return{root,repo,managed,head:git(repo,"rev-parse","HEAD")};};

describe("GitService integration",()=>{it("creates an isolated worktree and collects tracked plus untracked changes",async()=>{const f=fixture();const service=new GitService("git",f.managed);const worktree=await service.createWorktree(f.repo,{taskId:"TASK-ABC",attempt:1,baseSha:f.head});writeFileSync(path.join(worktree.worktreePath,"README.md"),"changed\n");writeFileSync(path.join(worktree.worktreePath,"new.txt"),"new\n");const evidence=await service.collectEvidence(worktree.worktreePath);expect(evidence.changedFiles.sort()).toEqual(["README.md","new.txt"]);expect(evidence.diff).toContain("new.txt");expect(readFileSync(path.join(f.repo,"README.md"),"utf8")).toBe("base\n");});it("rejects dirty repos, drifted SHA, duplicate branch, and cleanup outside managed root",async()=>{const f=fixture();const service=new GitService("git",f.managed);writeFileSync(path.join(f.repo,"dirty.txt"),"x");await expect(service.createWorktree(f.repo,{taskId:"TASK-A",attempt:1,baseSha:f.head})).rejects.toThrow("REPOSITORY_DIRTY");rmSync(path.join(f.repo,"dirty.txt"));await expect(service.createWorktree(f.repo,{taskId:"TASK-A",attempt:1,baseSha:"0".repeat(40)})).rejects.toThrow("BASE_SHA_CHANGED");await service.createWorktree(f.repo,{taskId:"TASK-A",attempt:1,baseSha:f.head});await expect(service.createWorktree(f.repo,{taskId:"TASK-A",attempt:1,baseSha:f.head})).rejects.toThrow();await expect(service.cleanupWorktree(f.repo,f.repo)).rejects.toThrow("outside managed root");});});
describe("GitService Phase 1.8 boundaries", () => {
  it("includes both sides of a staged rename and untracked stat without touching the source checkout", async () => {
    const f=fixture(); const service=new GitService("git",f.managed); const attempt=await service.createWorktree(f.repo,{taskId:"TASK-RENAME",attempt:1,baseSha:f.head});
    git(attempt.worktreePath,"mv","README.md","RENAMED.md");
    writeFileSync(path.join(attempt.worktreePath,"new.txt"),"new\n");
    const evidence=await service.collectEvidence(attempt.worktreePath);
    expect(evidence.changedFiles.sort()).toEqual(["README.md","RENAMED.md","new.txt"]);
    expect(evidence.stat).toContain("new.txt");
    expect(evidence.invalidPaths).toEqual([]);
    expect(readFileSync(path.join(f.repo,"README.md"),"utf8")).toBe("base\n");
  });
  it("marks a staged out-of-root symlink target unsafe", async () => {
    const f=fixture(); const service=new GitService("git",f.managed); const attempt=await service.createWorktree(f.repo,{taskId:"TASK-LINK",attempt:1,baseSha:f.head});
    const targetHash=execFileSync("git",["hash-object","-w","--stdin"],{cwd:attempt.worktreePath,input:"../../outside.txt",encoding:"utf8"}).trim();
    git(attempt.worktreePath,"update-index","--add","--cacheinfo",`120000,${targetHash},escape-link`);
    const evidence=await service.collectEvidence(attempt.worktreePath);
    expect(evidence.invalidPaths).toContain("escape-link");
  });
  it("marks a staged gitlink unsafe and refuses cleanup through an outside junction", async () => {
    const f=fixture(); const service=new GitService("git",f.managed); const attempt=await service.createWorktree(f.repo,{taskId:"TASK-SPECIAL",attempt:1,baseSha:f.head});
    git(attempt.worktreePath,"update-index","--add","--cacheinfo",`160000,${f.head},embedded-repo`);
    const evidence=await service.collectEvidence(attempt.worktreePath);
    expect(evidence.invalidPaths).toContain("embedded-repo");
    const junction=path.join(f.managed,"outside-link");
    symlinkSync(f.repo,junction,"junction");
    await expect(service.cleanupWorktree(f.repo,junction)).rejects.toThrow("outside managed root");
    expect(readFileSync(path.join(f.repo,"README.md"),"utf8")).toBe("base\n");
  });
});
