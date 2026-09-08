import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
  const cluster = (workspace:string) => (db.query("SELECT p.cluster_key FROM workspaces w JOIN projects p ON p.id=w.project_id WHERE w.id=?").get(workspace) as {cluster_key:string}).cluster_key;
  for (const [key,root] of [["trellis:home",homedir()],["trellis:scratch",join(home,".trellis/scratch")]]) {
    db.prepare("INSERT OR IGNORE INTO projects(id,name,cluster_key,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run(key,key,key,Date.now(),Date.now());
    const project=db.query("SELECT id FROM projects WHERE cluster_key=?").get(key) as {id:string};
    db.prepare("INSERT INTO workspaces(id,project_id,name,path,kind,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(`adopt-unit-${key}`,project.id,key,root,"directory","discovered",Date.now());
    const workspace=resolveAdoptionWorkspace(join(root,"unregistered-directory"));
    assert.equal(cluster(workspace),"trellis:external");
    assert.equal(cluster(resolveAdoptionWorkspace(root)),"trellis:external","exact system root must not be reused");
    assert.equal(cluster(`adopt-unit-${key}`),key,"existing sessions must retain their system workspace");
  }
  db.prepare("INSERT INTO projects VALUES ('not-git','private','dir:/private',NULL,1,1)").run();
  db.prepare("INSERT INTO workspaces(id,project_id,name,path,kind,created_by,created_at) VALUES ('not-git','not-git','tmp',?,'directory','discovered',1)").run(realpathSync('/tmp'));
  assert.equal(cluster(resolveAdoptionWorkspace(home)),"trellis:external","non-git /private/tmp cannot claim external cwd");
  assert.equal(cluster(resolveAdoptionWorkspace('/tmp')),"trellis:external","non-git exact root cannot be reused");
  mkdirSync(join(home,"symlink-target")); symlinkSync(join(home,"symlink-target"),join(home,"symlink-alias"));
  assert.equal(resolveAdoptionWorkspace(join(home,"symlink-alias")),resolveAdoptionWorkspace(join(home,"symlink-target")),"canonical fallback does not create duplicate workspaces");
  assert.equal(resolveAdoptionWorkspace(join(home,"repo/sub")),"adopt-fixture-workspace");
  mkdirSync(join(home,"repo/nested")); writeFileSync(join(home,"repo/nested/.git"),'gitdir: /fixture/worktree');
  db.prepare("INSERT INTO workspaces(id,project_id,name,path,kind,created_by,created_at) VALUES ('nested','adopt-fixture-project','nested',?,'worktree','discovered',1)").run(join(home,"repo/nested"));
  assert.equal(resolveAdoptionWorkspace(join(home,"repo/nested/src")),"nested","longest genuine root wins, .git file qualifies");
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
  assert.equal(adoptSnapshot(await snapshot(fresh.id)),null,"zero-turn threads must not create sessions");
  const started=await f.peer.request("turn/start",{threadId:fresh.id,input:[{type:"text",text:"hold external turn"}]});
  await Bun.sleep(30);
  const notified=await snapshot(fresh.id);
  assert.equal(adoptionTurns({...notified,items:[]},{[started.turn.id]:started.turn}).length,1,"turn notification is sufficient before the first item arrives");
  assert.equal(adoptionTurns({...s,items:[]},{[started.turn.id]:started.turn}).length,0,"another thread's notifications cannot trigger adoption");
  const notificationSid=adoptSnapshot({...notified,items:[]},{[started.turn.id]:started.turn})!;
  assert.ok(notificationSid,"first turn notification creates the session before items arrive");
  const freshSid=adoptSnapshot(await snapshot(fresh.id))!;
  assert.equal(freshSid,notificationSid);
  assert.equal(getNodes(freshSid)[0].question,"hold external turn","later items replace the provisional question");
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
  const {createProjectClient}=await import("../../lib/server/as-client");
  let failNextList=false;
  let observerClient: ReturnType<typeof createProjectClient>;
  const service=new AdoptionService(()=>{
    const client=createProjectClient({reconnect:false,observe:true}), request=client.request.bind(client);
    observerClient=client;
    client.request=((method,params)=>{
      if(method==="thread/list" && failNextList){failNextList=false;return Promise.reject(Error("fixture reconnect"));}
      return request(method,params);
    }) as typeof client.request;
    return client;
  });
  const state=service as unknown as {turns:Map<string,unknown>;snapshots:Map<string,{nextSeq:number}>;summaries:Map<string,unknown>;dirty:Set<string>;attached:Set<string>};
  const observed=(await f.peer.request("thread/start",{backend:"claude",cwd:join(home,"external"),model:"sonnet"})).thread;
  const observerCalls=()=>f.requests.filter(r=>r.client==="trellis-adopt");
  try {
    await service.scan(); await service.scan();
    let offset=observerCalls().length;
    await service.scan();
    assert.deepEqual(observerCalls().slice(offset).map(r=>r.method),["thread/list"],"unchanged scan is one list, zero attach");
    const cursor=state.snapshots.get(observed.id)!.nextSeq-1;
    await f.peer.request("turn/start",{threadId:observed.id,input:[{type:"text",text:"incremental first"}]});
    await complete(observed.id); await Bun.sleep(20);
    offset=observerCalls().length; await service.scan();
    const attaches=observerCalls().slice(offset).filter(r=>r.method==="thread/attach");
    assert.deepEqual(attaches.map(r=>r.params),[{threadId:observed.id,sinceSeq:cursor}],"idle-to-idle turn detected from notifications, only changed thread attaches");
    const observedSid=(getDB().query("SELECT session_id FROM as_adoptions WHERE thread_id=?").get(observed.id) as {session_id:string}).session_id;
    const first=getNodes(observedSid)[0]; assert.ok(first.response.includes("incremental first"));
    const nextCursor=state.snapshots.get(observed.id)!.nextSeq-1; assert.ok(nextCursor>0);
    await f.peer.request("turn/start",{threadId:observed.id,input:[{type:"text",text:"incremental second"}]});
    await complete(observed.id); await Bun.sleep(20);
    offset=observerCalls().length; await service.scan();
    assert.deepEqual(observerCalls().slice(offset).filter(r=>r.method==="thread/attach").map(r=>r.params),[{threadId:observed.id,sinceSeq:nextCursor}]);
    assert.equal(getNodes(observedSid).length,2); assert.equal(getNodes(observedSid)[0].response,first.response,"incremental snapshot preserves historical items");
    failNextList=true; await service.scan(); await service.scan();
    assert.equal(getNodes(observedSid).length,2,"reconnect reconciles using retained cursor without duplicate nodes");
    observerClient!.close();
    await f.peer.request("turn/start",{threadId:observed.id,input:[{type:"text",text:"missed while disconnected"}]}); await complete(observed.id);
    await service.scan();
    assert.equal(getNodes(observedSid).length,3,"idle-to-idle turn during a silent disconnect is recovered");
    await f.peer.request("turn/start",{threadId:observed.id,input:[{type:"text",text:"hold across disconnect"}]}); await Bun.sleep(30); await service.scan();
    assert.equal(getNodes(observedSid).at(-1)!.status,"streaming");
    observerClient!.close(); await f.peer.request("turn/interrupt",{threadId:observed.id}); await Bun.sleep(30); await service.scan();
    assert.equal(getNodes(observedSid).at(-1)!.status,"error","lost terminal notification cannot leave a turn streaming forever");
    await f.peer.request("thread/close",{threadId:observed.id}); await service.scan();
    assert.equal(getAdoption(observedSid)?.status,"closed");
    for(const cache of [state.turns,state.snapshots,state.summaries,state.dirty,state.attached]) assert.equal(cache.has(observed.id),false,"closed thread clears every cache");
    const removed=(await f.peer.request("thread/start",{backend:"claude",cwd:join(home,"external")})).thread;
    await service.scan();
    await f.peer.request("turn/start",{threadId:removed.id,input:[{type:"text",text:"delete cache"}]}); await complete(removed.id); await service.scan();
    const removedSid=(getDB().query("SELECT session_id FROM as_adoptions WHERE thread_id=?").get(removed.id) as {session_id:string}).session_id;
    assert.ok(state.turns.has(removed.id)); deleteSession(removedSid); await service.scan();
    for(const cache of [state.turns,state.snapshots,state.summaries,state.dirty,state.attached]) assert.equal(cache.has(removed.id),false,"deleted session clears every cache");
    assert.notEqual((await f.peer.request("thread/read",{threadId:removed.id})).thread.status.type,"closed");
    console.log("PASS: P1-1 exact home/scratch; P2-1 git/Herdr longest roots; P2-2 realpath; P1-2 incremental/idle/reconnect; P2-3 closed/deleted caches");
  } finally {service.stop();}
  let calls=0;
  for(const flags of [{TRELLIS_AS:"on",TRELLIS_AS_ADOPT:"off"},{TRELLIS_AS:"off",TRELLIS_AS_ADOPT:"on"}]) {
    Object.assign(process.env,flags); const service=new AdoptionService(()=>{calls++;throw Error("off made a request");}); await service.scan();service.stop();
    assert.equal(adoptSnapshot(s),null);
  }
  assert.equal(calls,0);
  console.log("PASS: mapping + Herdr worktree, fallback, exact items projection, idempotence/restart, closed refusal, permanent detach/new turn, flags zero requests");
} finally {f.peer.close();await f.daemon.shutdown();resetDBForTests();rmSync(home,{recursive:true,force:true});}
