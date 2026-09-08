import { mock } from "bun:test";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { AgentClient, MockEngine, type MockScript, type EngineItem, type EngineEvent } from "@smokingmouse/agent-server";
import { loadToken, resolveDaemonPaths, runDaemon } from "@smokingmouse/agent-server/daemon";
import { matchAdoptionRoot } from "../../lib/as-adopt";
mock.module("server-only", () => ({}));

export async function startFixture(home: string) {
  if (!home.startsWith("/tmp/trellis-as-adopt-")) throw Error("isolated fixture home required");
  const paths = resolveDaemonPaths({NODE_ENV:"test",HOME:home,AGENT_SERVER_SOCKET_PATH:join(home,"as.sock")});
  for (const dir of ["repo","checkout","external"]) mkdirSync(join(home,dir),{recursive:true});
  const script: MockScript = async function* (turnId,input,engine) {
    function* completed(item: EngineItem): Generator<EngineEvent> {
      yield {type:"itemStarted",turnId,item};
      yield {type:"itemCompleted",turnId,item};
    }
    const prompt = input.map(i => i.type === "text" ? i.text : "attachment").join("\n");
    if (prompt.includes("approval")) {
      yield {type:"itemStarted",turnId,item:{id:`${turnId}-bash`,type:"commandExecution",payload:{command:"echo adopted",cwd:home}}};
      yield {approval:{method:"item/commandExecution/requestApproval",params:{threadId:engine.options!.threadId,turnId,itemId:`${turnId}-bash`,requestId:`approval-${turnId}`,command:"echo adopted",cwd:home,startedAtMs:Date.now()}}};
      yield {type:"itemCompleted",turnId,item:{id:`${turnId}-bash`,type:"commandExecution",payload:{command:"echo adopted",cwd:home,aggregatedOutput:"adopted",exitCode:0}}};
    }
    yield* completed({id:`${turnId}-analysis`,type:"reasoning",payload:{text:"fixture reasoning"}});
    yield* completed({id:`${turnId}-pre`,type:"agentMessage",payload:{text:"先检查上下文"}});
    yield* completed({id:`${turnId}-tool`,type:"toolCall",payload:{name:"Read",input:{path:"fixture.txt"},output:"fixture contents"}});
    yield* completed({id:`${turnId}-mcp`,type:"mcpToolCall",payload:{server:"fixture",tool:"read",arguments:{},result:{ok:true}}});
    yield* completed({id:`${turnId}-edit`,type:"fileChange",payload:{changes:[{path:"fixture.txt",kind:"update",diff:"+adopted"}],status:"completed"}});
    yield* completed({id:`${turnId}-search`,type:"webSearch",payload:{query:"fixture",results:["one"]}});
    yield {type:"itemStarted",turnId,item:{id:`${turnId}-answer`,type:"agentMessage",payload:{text:""}}};
    yield {type:"itemDelta",turnId,itemId:`${turnId}-answer`,kind:"text",text:"正在回复："};
    if (prompt.includes("hold")) {
      while (!engine.closed && !engine.interrupted.includes(turnId)) await Bun.sleep(20);
      return;
    }
    yield {waitMs:150};
    yield {type:"itemCompleted",turnId,item:{id:`${turnId}-answer`,type:"agentMessage",payload:{text:`外部线程回复：${prompt}`}}};
    yield {type:"turnCompleted",turnId,status:"completed",forkPoint:`checkpoint-${turnId}`};
  };
  const daemon = await runDaemon({paths,graceMs:0,logger:()=>{},serverOptions:{defaultModel:"sonnet",allowedRoots:[home],backends:["claude"],engineFactory:()=>new MockEngine(script,"claude")}});
  const requests: {client:string;method:string}[] = [];
  const labels = new WeakMap<object,string>();
  const receive = daemon.server.receive.bind(daemon.server);
  daemon.server.receive = (connection,raw) => {
    const frame = raw as {method?:string;params?:{client?:{name?:string}}};
    if (frame.method === "initialize") labels.set(connection,frame.params?.client?.name ?? "unknown");
    if (frame.method) requests.push({client:labels.get(connection) ?? "unknown",method:frame.method});
    return receive(connection,raw);
  };
  const peer = await AgentClient.connectUnix({path:paths.socketPath,token:loadToken(paths.tokenPath),client:{name:"fixture-peer",version:"1",kind:"tui",label:"外部客户端"},capabilities:{engineEvents:true,serverRequests:["item/commandExecution/requestApproval"]},reconnect:false});
  const resolved: unknown[] = [];
  peer.onNotification("serverRequest/resolved",p=>resolved.push(p));
  const {getDB} = await import("../../lib/server/sqlite");
  const db = getDB(), now=Date.now();
  // A production backup may contain a historic /tmp workspace. Remove only
  // ancestor registrations in this isolated fixture DB so the unknown-cwd case
  // remains unknown; real production ownership is untouched.
  const roots=db.prepare("SELECT id,project_id AS projectId,path FROM workspaces").all() as {id:string;projectId:string;path:string}[];
  for(const root of roots) {
    try {root.path=realpathSync(root.path);} catch {}
    if(matchAdoptionRoot(realpathSync(join(home,"external")),[root])) {
      db.prepare("UPDATE sessions SET workspace_path=NULL WHERE workspace_id=?").run(root.id);
      db.prepare("DELETE FROM workspaces WHERE id=?").run(root.id);
    }
  }
  // Startup backfill must not recreate a deleted ancestor from an ungrouped
  // historic session in the copied DB.
  const oldSessions=db.prepare("SELECT id,workspace_path FROM sessions WHERE workspace_path IS NOT NULL").all() as {id:string;workspace_path:string}[];
  for(const session of oldSessions) {
    let root=session.workspace_path;try {root=realpathSync(root);} catch {}
    if(matchAdoptionRoot(realpathSync(join(home,"external")),[{id:session.id,projectId:"old",path:root}])) db.prepare("UPDATE sessions SET workspace_path=NULL WHERE id=?").run(session.id);
  }
  db.prepare("INSERT INTO projects(id,name,cluster_key,created_at,updated_at) VALUES (?,?,?,?,?)").run("adopt-fixture-project","收编测试项目",join(home,"repo"),now,now);
  db.prepare("INSERT INTO workspaces(id,project_id,name,path,kind,created_by,created_at) VALUES (?,?,?,?,?,?,?)").run("adopt-fixture-workspace","adopt-fixture-project","repo",join(home,"repo"),"directory","discovered",now);
  return {daemon,peer,requests,resolved,paths};
}

if (import.meta.main) {
  const home = process.argv[2], fixture = await startFixture(home);
  const server = Bun.serve({hostname:"127.0.0.1",port:3480,async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/proof") return Response.json({requests:fixture.requests,resolved:fixture.resolved});
    try {
      const {method,params} = await req.json();
      // Fixture controller is loopback-only, exposes only its own isolated daemon.
      return Response.json(await fixture.peer.request(method,params));
    } catch(error) {return Response.json({error:String(error)},{status:409});}
  }});
  writeFileSync(join(home,"ready"),"ready");
  async function stop(){server.stop(true);fixture.peer.close();await fixture.daemon.shutdown();process.exit(0);}
  process.on("SIGTERM",()=>void stop()); process.on("SIGINT",()=>void stop());
  await fixture.daemon.closed;
}
