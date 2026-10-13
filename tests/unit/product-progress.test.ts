import { describe, expect, it } from "vitest";
import { getProductProgress, type ProductProgressSnapshot } from "../../src/renderer/src/features/products/product-progress.js";
import type { TaskStatus } from "../../src/shared/core/task-state.js";

const fixture = (): ProductProgressSnapshot => ({
  overview: {product:{id:"P1",name:"Product",repositoryId:null,revision:2,goalRevision:1,confirmedGoalRevision:1,createdAt:"now",updatedAt:"now"},goal:{revision:1,hash:"a".repeat(64),createdAt:"now",goal:{schemaVersion:"1.0",originalRequest:"Idea",goal:"Goal",scope:"Scope",assumptions:[],acceptanceCriteria:[{id:"C1",description:"Works",verification:"user",required:true}]}}},
  plan:{current:true,directionConfirmed:true,saved:{productId:"P1",revision:1,hash:"b".repeat(64),createdAt:"now",confirmedAt:"now",plan:{schemaVersion:"1.0",productId:"P1",goalRevision:1,goalHash:"a".repeat(64),summary:"Plan",workItems:[{id:"W1",title:"Work",objective:"Goal",deliverable:"Result",acceptanceCriterionIds:["C1"],dependsOn:[]}]}}},
  execution:{productId:"P1",repositoryId:"R1",planRevision:1,planCurrent:true,planConfirmed:true,link:{productId:"P1",planRevision:1,taskId:"TASK-1",createdAt:"now"},taskStatus:"SPEC_APPROVED"},
  task:{id:"TASK-1",projectId:"R1",title:"Task",requestText:"Request",status:"SPEC_APPROVED",baseSha:"a".repeat(40),specJson:"{}",specRevision:1,specApprovedAt:"now",createdAt:"now",updatedAt:"now"},specHash:"c".repeat(64),
  run:null,delivery:{productId:"P1",latest:null,current:false},runtime:{passed:true,startedAt:"now",finishedAt:"now",steps:[]},planningAvailable:false
});
const run = (status: NonNullable<ProductProgressSnapshot["run"]>["status"]): NonNullable<ProductProgressSnapshot["run"]> => ({id:"RUN1",productId:"P1",planRevision:1,taskId:"TASK-1",specRevision:1,specHash:"c".repeat(64),status,stage:"build",reservedModelCalls:1,maxModelCalls:2,errorCode:null,createdAt:"now",finishedAt:status==="RUNNING"||status==="PAUSE_REQUESTED"||status==="CANCEL_REQUESTED"?null:"now"});

describe("product progress derived from authoritative records",()=>{
 it("orders unsaved direction, plan, repository and task prerequisites",()=>{
  const s=fixture();expect(getProductProgress(s,true)).toMatchObject({action:"goal",tone:"warning"});
  s.overview.product.confirmedGoalRevision=null;expect(getProductProgress(s,false).action).toBe("goal");
  s.overview.product.confirmedGoalRevision=1;s.plan.current=false;expect(getProductProgress(s,false).action).toBe("plan");
  s.plan.current=true;s.execution.repositoryId=null;expect(getProductProgress(s,false).action).toBe("repository");
  s.execution.repositoryId="R1";s.execution.link=null;expect(getProductProgress(s,false).action).toBe("repository");
 });
 it.each(["DRAFT","SPEC_READY"] as TaskStatus[])("routes %s to explicit spec decisions",status=>{
  const s=fixture();s.task!.status=status;expect(getProductProgress(s,false).action).toBe("task");
 });
 it("does not infer approval or runtime availability from task status",()=>{
  const s=fixture();s.task!.specApprovedAt=null;expect(getProductProgress(s,false).action).toBe("task");
  s.task!.specApprovedAt="now";s.runtime=null;expect(getProductProgress(s,false).action).toBe("runtime");
  s.runtime={passed:false,startedAt:"now",finishedAt:"now",steps:[]};expect(getProductProgress(s,false).action).toBe("runtime");
  s.runtime.passed=true;expect(getProductProgress(s,false).action).toBe("run");
 });
 it.each(["PAUSE_REQUESTED","CANCEL_REQUESTED","RUNNING"] as const)("shows actual active %s before proposing new work",status=>{
  const s=fixture();s.run=run(status);expect(getProductProgress(s,false).action).toBe("run");expect(getProductProgress(s,false).tone).not.toBe("success");
 });
 it.each(["REWORK","FAILED","BLOCKED","INTERRUPTED","CANCELLED","SPEC_INVALID"] as TaskStatus[])("keeps %s stopped and directs to evidence",status=>{
  const s=fixture();s.task!.status=status;expect(getProductProgress(s,false)).toMatchObject({action:"task",tone:"danger"});
 });
 it.each(["DESIGNING","PREPARING_WORKTREE","BUILDING","TESTING","DETERMINISTIC_GATE","REVIEWING"] as TaskStatus[])("explains a running %s task without dispatching",status=>{
  const s=fixture();s.task!.status=status;expect(getProductProgress(s,false)).toMatchObject({action:"task",tone:"info"});
 });
 it("ignores old product, task, plan and spec actions",()=>{
  for(const patch of [{productId:"P2"},{taskId:"TASK-2"},{planRevision:2},{specRevision:2},{specHash:"d".repeat(64)}]){
   const s=fixture();s.run={...run("CANCEL_REQUESTED"),...patch};expect(getProductProgress(s,false).title).toBe("已批准计划等待执行");
  }
 });
 it("rejects stale or mismatched plan and task milestones",()=>{
  for(const change of [(s:ProductProgressSnapshot)=>{s.plan.saved!.plan.goalHash="d".repeat(64);},(s:ProductProgressSnapshot)=>{s.plan.saved!.plan.goalRevision=2;},(s:ProductProgressSnapshot)=>{s.plan.directionConfirmed=false;}]){
   const s=fixture();change(s);expect(getProductProgress(s,false)).toMatchObject({action:"plan"});expect(getProductProgress(s,false).milestones[3].complete).toBe(false);
  }
  const s=fixture();s.task!.projectId="OtherRepo";expect(getProductProgress(s,false).action).toBe("repository");
  expect(getProductProgress(s,false).title).toBe("任务关联需要核对");
 });
 it("separates technical pass, business review, evidence drift and unpublished acceptance",()=>{
  const s=fixture();s.task!.status="PASSED";expect(getProductProgress(s,false)).toMatchObject({action:"delivery",title:"等待产品业务验收"});
  s.delivery={productId:"P1",current:true,latest:{id:"D1",productId:"P1",goalRevision:1,goalHash:"a".repeat(64),planRevision:1,planHash:"b".repeat(64),criteria:s.overview.goal.goal.acceptanceCriteria,reviews:[{criterionId:"C1",accepted:false,taskCriterionIds:[],note:"Needs review"}],evidence:{taskId:"TASK-1",specRevision:1,specHash:s.specHash!,attemptId:"A1",branch:"branch",worktreePath:"managed",head:"a".repeat(40),diffHash:"d".repeat(64),manifestHash:"e".repeat(64),finalGateHash:"f".repeat(64),testRunIds:["T1"]},runInstructions:"Read",limitations:"Unpublished",status:"REVIEW_REQUIRED",previewStatus:"NOT_RUN",publicationStatus:"NOT_RUN",createdAt:"now"}};
  expect(getProductProgress(s,false).tone).not.toBe("success");
  s.delivery.latest!.status="ACCEPTED_UNPUBLISHED";expect(getProductProgress(s,false)).toMatchObject({tone:"success",action:"delivery"});
  expect(getProductProgress(s,false).description).toContain("预览和发布仍未运行");
  s.delivery.current=false;expect(getProductProgress(s,false)).toMatchObject({action:"task",tone:"warning"});expect(getProductProgress(s,false).milestones[3].complete).toBe(false);
  s.delivery.latest!.goalHash="old";expect(getProductProgress(s,false).title).toBe("等待产品业务验收");
 });
 it("requires checking failed actions and an explicit decision after pause",()=>{
  const s=fixture();s.run=run("FAILED");expect(getProductProgress(s,false).action).toBe("task");
  s.run=run("INTERRUPTED");expect(getProductProgress(s,false).action).toBe("task");
  s.run=run("PAUSED");expect(getProductProgress(s,false).title).toContain("暂停");
  s.run=run("CANCELLED");expect(getProductProgress(s,false).title).toContain("已取消");
 });
});
