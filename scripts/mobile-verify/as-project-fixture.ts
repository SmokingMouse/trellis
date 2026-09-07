import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentClient, MockEngine, type MockScript } from "@smokingmouse/agent-server";
import { loadToken, resolveDaemonPaths, runDaemon } from "@smokingmouse/agent-server/daemon";
import type { StartThreadParams } from "@smokingmouse/agent-server/protocol";
import { pickResponse } from "../../lib/llm/mock-responses";
const home = process.argv[2];
if (!home?.startsWith("/tmp/trellis-as-project-")) throw new Error("isolated home required");
const paths = resolveDaemonPaths({ NODE_ENV:"test", HOME:home, AGENT_SERVER_SOCKET_PATH:join(home,"as.sock") });
const engines: MockEngine[] = [];
const peerEvents: unknown[] = [];
function save() {
  writeFileSync(join(home,"counts.json"), JSON.stringify({spawns:engines.reduce((n,e)=>n+e.spawnCount,0),turns:engines.reduce((n,e)=>n+e.sent.length,0),engines:engines.map(e=>({thread:e.options?.threadId, options:e.options, sent:e.sent, interrupted:e.interrupted})), peerEvents}));
}
async function waitFile(file:string) {
  const deadline = Date.now()+120000;
  while(!existsSync(join(home,file))) { if(Date.now()>deadline) throw new Error(`fixture timeout ${file}`); await Bun.sleep(50); }
}
const script: MockScript = async function* (turnId,input,engine) {
  save();
  const prompt = input.filter(i=>i.type==="text").map(i=>i.text).join("\n");
  const answer = pickResponse(prompt,[],null);
  const id = `${turnId}-answer`;
  if(prompt.includes("approval")) {
    const toolId = `${turnId}-bash`;
    yield {type:"itemStarted",turnId,item:{id:toolId,type:"commandExecution",payload:{command:"echo project-proof",cwd:home}}};
    yield {approval:{method:"item/commandExecution/requestApproval",params:{requestId:`approval-${turnId}`,threadId:engine.options!.threadId,turnId,itemId:toolId,command:"echo project-proof",cwd:home,startedAtMs:Date.now()}}};
    yield {type:"itemCompleted",turnId,item:{id:toolId,type:"commandExecution",payload:{command:"echo project-proof",cwd:home,aggregatedOutput:"project-proof",exitCode:0}}};
  }
  yield {type:"itemStarted",turnId,item:{id,type:"agentMessage",payload:{text:""}}};
  yield {type:"itemDelta",turnId,itemId:id,kind:"text",text:answer.slice(0,20)};
  if(prompt.includes("hold")) await waitFile("finish-first");
  if(prompt.includes("interrupt")) { yield {waitMs:120000}; return; }
  yield {type:"itemCompleted",turnId,item:{id,type:"agentMessage",payload:{text:answer}}};
  yield {type:"turnCompleted",turnId,status:"completed",usage:{usd:null,inputTokens:Math.ceil(prompt.length/4),outputTokens:Math.ceil(answer.length/4),cachedTokens:0,cacheCreation:0,estimated:true,contextTokens:null}};
};
class ProjectMock extends MockEngine {
  async setPermission(permission:NonNullable<StartThreadParams["permission"]>) {
    this.emit({type:"permissionChanged",permission:permission==="auto-edit"?"acceptEdits":permission});
  }
}
const daemon = await runDaemon({paths,graceMs:0,serverOptions:{backends:["claude"],allowedRoots:[home],engineFactory:()=>{
  const engine=new ProjectMock(script,"claude"); engines.push(engine); return engine;
}}});
const peer = await AgentClient.connectUnix({path:paths.socketPath,token:loadToken(paths.tokenPath),client:{name:"peer",version:"1",kind:"tui",label:"第二终端"},capabilities:{engineEvents:true,serverRequests:["item/commandExecution/requestApproval"]},reconnect:false});
peer.onNotification("item/agentMessage/delta",p=>{peerEvents.push({type:"delta",...p});save();});
peer.onNotification("serverRequest/resolved",p=>{peerEvents.push({type:"resolved",...p});save();});
const attached=new Set<string>();
let polling=false;
const timer=setInterval(async()=>{
  if(polling) return; polling=true;
  try {
    const {threads}=await peer.request("thread/list",{});
    for(const thread of threads) if(!attached.has(thread.id)) {
      await peer.request("thread/attach",{threadId:thread.id,sinceSeq:0}); attached.add(thread.id);
      writeFileSync(join(home,"peer-attached"),thread.id);
    }
    for(const engine of engines) if(!engine.closed) engine.emit({type:"engineEvent",backend:"claude",subtype:"system",payload:{type:"system",subtype:"project-proof",message:"系统日志验证"}});
    if(existsSync(join(home,"approve-other"))) for(const request of peer.pendingRequests.values()) {
      if(request.method!=="item/commandExecution/requestApproval") continue;
      await peer.request("thread/lease/acquire",{threadId:request.params.threadId,ttlMs:3000});
      request.respond({decision:"accept"});
      await Bun.sleep(100);
      await peer.request("thread/lease/release",{threadId:request.params.threadId});
    }
    save();
  } catch(error) { console.error(error); } finally {polling=false;}
},250);
writeFileSync(join(home,"ready"),"ready");
let stopping=false;
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);peer.close();await daemon.shutdown();process.exit(0);}
process.on("SIGTERM",()=>void stop());process.on("SIGINT",()=>void stop());
await daemon.closed;
