import { expect, test } from "bun:test";
import type { Item, Turn, PendingServerRequest } from "@smokingmouse/agent-server/protocol";
import { itemToolCall, projectInteraction, projectResponse, projectThreadOptions, turnRunEvent } from "./as-project-events";
import { applyThreadEvent, emptyThreadLog } from "./as-thread-log";

const item = (id:string, seq:number, text:string): Extract<Item,{type:"agentMessage"}> => ({id, seq, turnId:"turn", startedAtMs:10, type:"agentMessage", payload:{text}});
test("message boundaries determine finalStart and preserve order", () => {
  expect(projectResponse([item("b",3,"answer"),item("a",1,"preface")])).toEqual({response:"preface\n\nanswer",finalStart:9});
  expect(projectResponse([item("a",1,"partial")])).toEqual({response:"partial",finalStart:0});
});
test("command completion preserves failure, output and timestamps", () => {
  expect(itemToolCall({id:"tool",seq:2,turnId:"turn",startedAtMs:10,completedAtMs:45,type:"commandExecution",status:"completed",
    payload:{command:"exit 1",cwd:"/tmp",aggregatedOutput:"failure",exitCode:1}})).toMatchObject({id:"tool",name:"Bash",status:"error",output:"failure",durationMs:35});
  expect(itemToolCall(item("message",3,"text"))).toBeNull();
});
test("server requests retain stable request identity and question options", () => {
  const request: PendingServerRequest = {method:"item/tool/requestUserInput",params:{threadId:"th",turnId:"tn",itemId:"it",requestId:"ar",isBlocking:true,questions:[{id:"q1",question:"which?"}]}};
  expect(projectInteraction(request)).toMatchObject({toolUseId:"ar",toolName:"AskUserQuestion",input:{questions:[{id:"q1",options:[]}]}});
});
test("project policy maps model, explicit plan and effort without inventing budgets", () => {
  const session = {model:"claude-opus",workspacePath:"/tmp/project",requireApproval:true};
  expect(projectThreadOptions(session)).toMatchObject({backend:"claude",model:"claude-opus",permission:"default",cwd:"/tmp/project"});
  expect(projectThreadOptions(session,{permission:"plan",effort:"high"})).toMatchObject({permission:"plan",effort:"high"});
  expect(projectThreadOptions({...session,model:"codex:gpt-5",requireApproval:false})).toMatchObject({backend:"codex",model:"gpt-5",permission:"full"});
});
test("turn termination maps usage and abort independently of items", () => {
  const turn:Turn = {id:"tn",threadId:"th",ordinal:1,status:"completed",enqueuedAtMs:0,durationMs:25,
    usage:{inputTokens:8,outputTokens:4,cachedTokens:2,cacheCreation:1,contextTokens:10,usd:null,estimated:false}};
  expect(turnRunEvent(turn,9)).toMatchObject({type:"done",finalStart:9,durationMs:25,usage:{input:8,output:4,cacheRead:2,cacheCreation:1,contextTokens:10}});
  expect(turnRunEvent({...turn,status:"interrupted"},0)).toEqual({type:"error",message:"aborted"});
});
test("partial snapshot and completed payload replace text without duplication", () => {
  let log=emptyThreadLog();
  const partial={...item("a",1,"hello"),status:"inProgress" as const};
  log=applyThreadEvent(log,{type:"notification",notification:{jsonrpc:"2.0",method:"item/started",params:{threadId:"th",turnId:"turn",itemId:"a",seq:1,startedAtMs:10,item:partial}}});
  log=applyThreadEvent(log,{type:"notification",notification:{jsonrpc:"2.0",method:"item/agentMessage/delta",params:{threadId:"th",turnId:"turn",itemId:"a",delta:" world"}}});
  const completion={jsonrpc:"2.0" as const,method:"item/completed" as const,params:{threadId:"th",turnId:"turn",itemId:"a",seq:2,completedAtMs:20,item:{...partial,completedSeq:2,completedAtMs:20,status:"completed" as const,payload:{text:"hello world!"}}}};
  log=applyThreadEvent(log,{type:"notification",notification:completion});
  log=applyThreadEvent(log,{type:"notification",notification:completion});
  expect(projectResponse(Object.values(log.items))).toEqual({response:"hello world!",finalStart:0});
});
