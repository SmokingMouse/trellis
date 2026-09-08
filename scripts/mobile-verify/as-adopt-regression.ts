import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";
import { isAdoptEnabled } from "../../lib/as-config";
import { adoptionTurns, matchAdoptionRoot } from "../../lib/as-adopt";
import { projectResponse, itemToolCall } from "../../lib/as-project-events";
mock.module("server-only",()=>({}));
const home=mkdtempSync("/tmp/trellis-as-adopt-unit-");
Object.assign(process.env,{TRELLIS_DB_PATH:join(home,"test.db"),TRELLIS_AS:"on",TRELLIS_AS_ADOPT:"on",TRELLIS_AS_SOCKET:join(home,"as.sock"),TRELLIS_AS_TOKEN_PATH:join(home,".agent-server/token"),TRELLIS_HERDR:"off"});
const {startFixture}=await import("./as-adopt-fixture");
const f=await startFixture(home);
const {adoptSnapshot,resolveAdoptionWorkspace,AdoptionService,getAdoption}=await import("../../lib/server/as-adopt");
const {getDB,resetDBForTests}=await import("../../lib/server/sqlite");
const {getSession,getSessionNodes:getNodes,deleteSession}=await import("../../lib/server/repo");
const as=await import("../../lib/server/as-project");
const bindings=await import("../../lib/server/session-binding");
const db=getDB();
async function snapshot(id:string) {return f.peer.request("thread/attach",{threadId:id,sinceSeq:0});}
async function complete(id:string) {
  for(let i=0;i<100;i++){const s=await snapshot(id);if(s.thread.status.type!=="running")return s;await Bun.sleep(25);}
  throw Error("fixture completion timeout");
}
try {
  assert.equal(isAdoptEnabled({TRELLIS_AS:"on"}),false);
  assert.equal(isAdoptEnabled({TRELLIS_AS:"on",TRELLIS_AS_ADOPT:"off"}),false);
  assert.equal(isAdoptEnabled({TRELLIS_AS:"on",TRELLIS_AS_ADOPT:"on"}),true);
  assert.equal(isAdoptEnabled({TRELLIS_AS:"off",TRELLIS_AS_ADOPT:"on",TRELLIS_AS_SOCKET:"x"}),false);
  assert.equal(matchAdoptionRoot("/a/bb",[{id:"w",projectId:"p",path:"/a/b"}]),null);
  assert.equal(matchAdoptionRoot("/a/b/src",[{id:"outer",projectId:"p",path:"/a"},{id:"inner",projectId:"p",path:"/a/b"}])?.id,"inner");
  // System home/scratch workspaces must not claim unrelated directories below them.
  for (const [key,root] of [["trellis:home",home],["trellis:scratch",join(home,".trellis/scratch")]]) {
    db.prepare("INSERT OR IGNORE INTO projects(id,name,cluster_key,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run(key,key,key,Date.now(),Date.now());
    const project=db.query("SELECT id FROM projects WHERE cluster_key=?").get(key) as {id:string};
    db.prepare("INSERT INTO workspaces(id,project_id,name,path,kind,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(`adopt-unit-${key}`,project.id,key,root,"directory","discovered",Date.now());
    const workspace=resolveAdoptionWorkspace(join(root,"unregistered-directory"));
    assert.equal((db.query("SELECT p.cluster_key FROM workspaces w JOIN projects p ON p.id=w.project_id WHERE w.id=?").get(workspace) as {cluster_key:string}).cluster_key,"trellis:external");
  }
  assert.equal(resolveAdoptionWorkspace(join(home,"repo/sub")),"adopt-fixture-workspace");
  const worktree=resolveAdoptionWorkspace(join(home,"checkout/src"),[{repo_root:join(home,"repo"),checkout_path:join(home,"checkout")}]);
  assert.equal((db.prepare("SELECT project_id FROM workspaces WHERE id=?").get(worktree) as {project_id:string}).project_id,"adopt-fixture-project");
  const {thread}=await f.peer.request("thread/start",{backend:"claude",cwd:join(home,"external"),model:"sonnet",meta:{title:"fixture title",fjContext:{cid:"fj-proof"}}});
  await f.peer.request("turn/start",{threadId:thread.id,input:[{type:"text",text:"backfill"}]});
  const s=await complete(thread.id), sid=adoptSnapshot(s)!;
  assert.equal(s.thread.status.type,"idle"); assert.ok(s.items.length >= 8); assert.ok(s.items.some(i=>i.type==="mcpToolCall"));
  assert.equal(getSession(sid)!.origin,"external");
  assert.equal(getSession(sid)!.title,"fj-proof · fixture title");
  assert.equal((db.prepare("SELECT p.name FROM projects p JOIN workspaces w ON w.project_id=p.id JOIN sessions s ON s.workspace_id=w.id WHERE s.id=?").get(sid) as {name:string}).name,"外部会话");
  for(const group of adoptionTurns(s)) {
    const node=getNodes(sid).find(n=>n.question===group.question)!;
    assert.equal(node.response,projectResponse(group.items).response);
    assert.deepEqual(node.toolCalls,group.items.map(itemToolCall).filter(Boolean));
    assert.equal(node.origin,"external"); assert.equal(node.backend,"claude");
  }
  assert.equal(adoptSnapshot(s),sid); assert.equal(getNodes(sid).length,1);
  mkdirSync(join(home,"late-checkout"));
  const late=structuredClone(s);late.thread.id="late-herdr-thread";late.thread.cwd=realpathSync(join(home,"late-checkout"));
  const lateSid=adoptSnapshot(late)!;
  const lateWorkspace=getSession(lateSid)!.workspaceId;
  assert.equal((db.query("SELECT p.cluster_key FROM workspaces w JOIN projects p ON p.id=w.project_id WHERE w.id=?").get(lateWorkspace) as {cluster_key:string}).cluster_key,"trellis:external");
  adoptSnapshot(late,{},[{repo_root:join(home,"repo"),checkout_path:late.thread.cwd}]);
  assert.equal((db.query("SELECT project_id FROM workspaces WHERE id=?").get(getSession(lateSid)!.workspaceId) as {project_id:string}).project_id,"adopt-fixture-project");
  resetDBForTests(); assert.equal(adoptSnapshot(s),sid); assert.equal(getNodes(sid).length,1);
  await f.peer.request("thread/close",{threadId:thread.id});
  adoptSnapshot(await snapshot(thread.id)); assert.equal(getAdoption(sid)?.status,"closed");
  const {POST}=await import("../../app/api/chat/route");
  const reply=await POST(new Request("http://localhost/api/chat",{method:"POST",body:JSON.stringify({kind:"branch",parentNodeId:getNodes(sid)[0].id,question:"must reject"}),headers:{"Content-Type":"application/json"}}));
  assert.equal(reply.status,409); assert.equal(getNodes(sid).length,1);
  const fresh=(await f.peer.request("thread/start",{backend:"claude",cwd:join(home,"external")})).thread;
  const freshSid=adoptSnapshot(await snapshot(fresh.id))!;
  bindings.pruneAsThreads(freshSid);
  assert.ok(getDB().prepare("SELECT 1 FROM as_threads WHERE session_id=?").get(freshSid),"empty external binding must survive pruning");
  await f.peer.request("turn/start",{threadId:fresh.id,input:[{type:"text",text:"hold external turn"}]});
  await Bun.sleep(30);
  adoptSnapshot(await snapshot(fresh.id));
  const live=getNodes(freshSid)[0];assert.equal(live.status,"streaming");
  const {createBranchNode}=await import("../../lib/server/repo");
  const child="busy-child";
  createBranchNode({nodeId:child,parentId:live.id,question:"must not silently fork busy tip",parentAnchor:null,now:Date.now()});
  await assert.rejects(()=>as.startProjectRun({nodeId:child,prompt:"busy",attachments:[]}),/still running/);
  getDB().prepare("DELETE FROM nodes WHERE id=?").run(child);
  await as.interruptProject(live.id);
  adoptSnapshot(await snapshot(fresh.id));
  assert.equal(getNodes(freshSid)[0].status,"error");
  assert.equal((await snapshot(fresh.id)).thread.status.type,"idle");
  deleteSession(freshSid);
  assert.notEqual((await f.peer.request("thread/read",{threadId:fresh.id})).thread.status.type,"closed");
  assert.equal(adoptSnapshot(await snapshot(fresh.id)),null);
  await f.peer.request("thread/resume",{threadId:fresh.id});
  await f.peer.request("turn/start",{threadId:fresh.id,input:[{type:"text",text:"after permanent detach"}]});
  assert.equal(adoptSnapshot(await complete(fresh.id)),null);
  const forkSource=(await f.peer.request("thread/start",{backend:"claude",cwd:join(home,"external"),model:"sonnet"})).thread;
  await f.peer.request("turn/start",{threadId:forkSource.id,input:[{type:"text",text:"first seed"}]});
  const forkSid=adoptSnapshot(await complete(forkSource.id))!;
  const tip=getNodes(forkSid)[0];
  createBranchNode({nodeId:"fork-child",parentId:tip.id,question:"explicit fork",parentAnchor:null,now:Date.now()});
  const run=await as.startProjectRun({nodeId:"fork-child",prompt:"explicit fork",attachments:[],fork:true});
  const forked=await complete(run.threadId);
  assert.notEqual(run.threadId,forkSource.id);assert.ok(forked.items.some(i=>i.type==="userMessage"&&i.payload.content.some(c=>c.type==="text"&&c.text==="first seed")));
  assert.equal(getNodes(forkSid).find(n=>n.id==="fork-child")!.origin,"external");
  run.close();
  const previousFork=bindings.getAsTurn("fork-child")!.thread_id;
  const retry=await as.startProjectRun({nodeId:"fork-child",prompt:"hold retry",attachments:[],retry:true});
  const retrySnapshot=await snapshot(retry.threadId);
  assert.equal(adoptSnapshot(retrySnapshot),null,"in-flight retry fork is already claimed by Trellis");
  await as.interruptProject("fork-child");await Bun.sleep(30);retry.close();
  assert.equal(bindings.getAsTurn("fork-child")!.thread_id,previousFork);
  deleteSession(forkSid);
  assert.equal(adoptSnapshot(await snapshot(retry.threadId)),null,"deleting the session keeps its in-flight thread claim tombstone");
  const deleting=(await f.peer.request("thread/start",{backend:"claude",cwd:join(home,"external")})).thread;
  await f.peer.request("turn/start",{threadId:deleting.id,input:[{type:"text",text:"hold during deletion"}]});
  await Bun.sleep(30);
  const deletingSid=adoptSnapshot(await snapshot(deleting.id))!;
  const observer=await as.getProjectRun(getNodes(deletingSid)[0].id);
  assert.ok(observer);
  let disconnected=false;observer.subscribe({onEvent:()=>{},onClose:()=>{disconnected=true;}});
  const {DELETE}=await import("../../app/api/sessions/[id]/route");
  await DELETE(new Request("http://localhost"),{params:Promise.resolve({id:deletingSid})});
  assert.equal(disconnected,true);
  assert.equal((await snapshot(deleting.id)).thread.status.type,"running");
  assert.equal(adoptSnapshot(await snapshot(deleting.id)),null);
  await f.peer.request("turn/interrupt",{threadId:deleting.id});
  const closed=(await f.peer.request("thread/start",{backend:"claude",cwd:join(home,"external")})).thread;
  await f.peer.request("thread/close",{threadId:closed.id}); assert.equal(adoptSnapshot(await snapshot(closed.id)),null);
  let calls=0;
  for(const flags of [{TRELLIS_AS:"on",TRELLIS_AS_ADOPT:"off"},{TRELLIS_AS:"off",TRELLIS_AS_ADOPT:"on"}]) {
    Object.assign(process.env,flags); const service=new AdoptionService(()=>{calls++;throw Error("off made a request");}); await service.scan();service.stop();
    assert.equal(adoptSnapshot(s),null);
  }
  assert.equal(calls,0);
  console.log("PASS: mapping + Herdr worktree, fallback, exact items projection, idempotence/restart, closed refusal, permanent detach/new turn, flags zero requests");
} finally {f.peer.close();await f.daemon.shutdown();resetDBForTests();rmSync(home,{recursive:true,force:true});}
