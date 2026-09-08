import assert from "node:assert/strict";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { writeFileSync, readFileSync } from "node:fs";
import type { AttachResult, Method, MethodParams, MethodResult } from "@smokingmouse/agent-server/protocol";
import { adoptionTurns } from "../../lib/as-adopt";
import { projectResponse, itemToolCall } from "../../lib/as-project-events";
const home=process.argv[2], phase=process.argv[3] ?? "main";
const base="http://127.0.0.1:3479", fixture="http://127.0.0.1:3480";
const headers={"Content-Type":"application/json",Cookie:"trellis_auth=as-adopt-token"};
const db=new Database(process.env.TRELLIS_DB_PATH!,{readonly:true});
async function rpc<M extends Method>(method:M,params:MethodParams<M>):Promise<MethodResult<M>> {
  const r=await fetch(fixture,{method:"POST",headers,body:JSON.stringify({method,params})});
  const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;
}
async function api(url:string,body?:unknown,method=body?"POST":"GET") {
  const r=await fetch(base+url,{method,headers,body:body?JSON.stringify(body):undefined});
  const text=await r.text();assert.equal(r.status,200,text);return text;
}
async function wait<T>(label:string,fn:()=>Promise<T>|T,timeout=10000):Promise<NonNullable<T>> {
  const end=Date.now()+timeout;
  do {const value=await fn();if(value){console.log("PASS: "+label);return value as NonNullable<T>;} await Bun.sleep(50);}while(Date.now()<end);
  throw Error(label+" timeout");
}
async function settled(threadId:string) {
  return wait("peer turn settles",async()=>{const s=await rpc("thread/attach",{threadId,sinceSeq:0});return s.thread.status.type!=="running" && s.items.some(i=>i.type==="agentMessage"&&i.status==="completed") ? s : null;});
}
function sessionFor(threadId:string) {return db.query("SELECT session_id AS id FROM as_adoptions WHERE thread_id=? AND session_id IS NOT NULL").get(threadId) as {id:string}|null;}
function nodes(sid:string) {return db.query("SELECT * FROM nodes WHERE session_id=? ORDER BY created_at").all(sid) as {id:string;parent_id:string|null;question:string;response:string;tool_calls_json:string;status:string;pending_interaction_json:string|null}[];}
async function parity(sid:string,snapshot:AttachResult) {
  await wait("every turn and item projection matches daemon",()=>{
    const current=nodes(sid), groups=adoptionTurns(snapshot);
    return groups.length===current.length && groups.every((g,i)=> current[i].question===g.question && current[i].response===projectResponse(g.items).response && JSON.stringify(JSON.parse(current[i].tool_calls_json??"[]"))===JSON.stringify(g.items.map(itemToolCall).filter(Boolean)) && current[i].parent_id===(i?current[i-1].id:null));
  });
}
try {
  if(phase==="main") {
    const began=Date.now();
    const {thread}=await rpc("thread/start",{backend:"claude",cwd:join(home,"repo"),model:"sonnet",meta:{title:"主页收编验证",fjContext:{cid:"fj-adopt-proof"}}});
    await rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"backfill proof"}]});
    const before=await settled(thread.id);
    const sid=(await wait("new external thread adopted within five seconds",()=>sessionFor(thread.id),4500)).id;
    assert.ok(Date.now()-began<=5000,`adoption took ${Date.now()-began}ms`);
    const list=JSON.parse(await api("/api/sessions"));
    const session=list.sessions.find((s:{id:string})=>s.id===sid);
    assert.equal(session.workspaceId,"adopt-fixture-workspace");assert.equal(session.origin,"external");assert.equal(session.backend,"claude");
    assert.ok(session.title.includes("fj-adopt-proof"));
    await parity(sid,before);
    await rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"external second turn"}]});
    await parity(sid,await settled(thread.id));
    const text=await api("/api/chat",{kind:"branch",parentNodeId:nodes(sid).at(-1)!.id,question:"web third turn",provider:"mock"});
    assert.ok(text.includes('"type":"done"'),text);
    const web=await settled(thread.id);assert.ok(web.items.some(i=>i.type==="userMessage" && i.payload.content.some(c=>c.type==="text"&&c.text.includes("web third turn"))));
    await parity(sid,web);
    await rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"approval external"}]});
    const pending=await wait("external approval appears as a home node",()=>nodes(sid).find(n=>n.pending_interaction_json));
    await api(`/api/nodes/${pending.id}/respond`,{toolUseId:JSON.parse(pending.pending_interaction_json!).toolUseId,behavior:"allow"});
    await wait("daemon broadcasts web decision",async()=>{const p=await (await fetch(fixture+"/proof")).json();return p.resolved.some((r:{decidedBy:{label:string}})=>r.decidedBy.label==="Trellis 网页");});
    await parity(sid,await settled(thread.id));
    await wait("approval card withdrawn",()=>nodes(sid).every(n=>!n.pending_interaction_json));
    const fallback=(await rpc("thread/start",{backend:"claude",cwd:join(home,"external"),model:"sonnet"})).thread;
    const fallbackSid=(await wait("empty external thread has a session",()=>sessionFor(fallback.id),4500)).id;
    const project=db.query("SELECT p.name,p.cluster_key FROM projects p JOIN workspaces w ON w.project_id=p.id JOIN sessions s ON s.workspace_id=w.id WHERE s.id=?").get(fallbackSid) as {name:string;cluster_key:string};
    assert.deepEqual(project,{name:"外部会话",cluster_key:"trellis:external"});
    // First home question on an empty adopted thread must reuse it too.
    assert.ok((await api("/api/chat",{kind:"root",sessionId:fallbackSid,question:"first home turn",provider:"mock"})).includes('"type":"done"'));
    await parity(fallbackSid,await settled(fallback.id));
    assert.equal((db.query("SELECT root_node_id FROM sessions WHERE id=?").get(fallbackSid) as {root_node_id:string}).root_node_id,nodes(fallbackSid)[0].id);
    await rpc("thread/close",{threadId:fallback.id});
    await wait("external close retained in home",()=>{const s=db.query("SELECT status FROM as_adoptions WHERE session_id=?").get(fallbackSid) as {status:string};return s.status==="closed";});
    const reject=await fetch(base+"/api/chat",{method:"POST",headers,body:JSON.stringify({kind:"branch",parentNodeId:nodes(fallbackSid)[0].id,question:"closed must reject"})});
    assert.equal(reject.status,409);
    const empty=(await rpc("thread/start",{backend:"claude",cwd:join(home,"external"),model:"sonnet"})).thread;
    const emptySid=(await wait("empty UI fixture adopted",()=>sessionFor(empty.id),4500)).id;
    writeFileSync(join(home,"proof.json"),JSON.stringify({sid,threadId:thread.id,nodeId:nodes(sid).at(-1)!.id,fallbackSid,emptySid,emptyThreadId:empty.id,items:web.items},null,2));
    console.log("PASS: ownership, backfill, peer live turn, home turn visible to peer, approval resolved, empty thread, closed refusal");
  } else if(phase==="empty-ui") {
    const proof=JSON.parse(readFileSync(join(home,"proof.json"),"utf8"));
    const snap=await settled(proof.emptyThreadId);
    assert.ok(snap.items.some(i=>i.type==="userMessage"&&i.payload.content.some(c=>c.type==="text"&&c.text==="empty home UI proof")));
    await parity(proof.emptySid,snap);
    assert.equal(nodes(proof.emptySid).length,1);
    assert.equal((db.query("SELECT root_node_id FROM sessions WHERE id=?").get(proof.emptySid) as {root_node_id:string}).root_node_id,nodes(proof.emptySid)[0].id);
    console.log("PASS: empty adopted thread accepts first question from home UI on its original thread");
  } else if(phase==="delete") {
    const proof=JSON.parse(readFileSync(join(home,"proof.json"),"utf8"));
    await api(`/api/sessions/${proof.sid}`,undefined,"DELETE");
    assert.notEqual((await rpc("thread/read",{threadId:proof.threadId})).thread.status.type,"closed");
    await rpc("turn/start",{threadId:proof.threadId,input:[{type:"text",text:"after permanent detach"}]});
    await settled(proof.threadId);await Bun.sleep(3500);assert.equal(sessionFor(proof.threadId),null);
    assert.equal((db.query("SELECT session_id FROM as_adoptions WHERE thread_id=?").get(proof.threadId) as {session_id:null}).session_id,null);
    console.log("PASS: delete only detaches; new external turns never re-adopt the tombstone");
  } else if(phase==="off") {
    const before=await (await fetch(fixture+"/proof")).json();
    const count=before.requests.filter((r:{client:string})=>["trellis-adopt","trellis-project"].includes(r.client)).length;
    const {thread}=await rpc("thread/start",{backend:"claude",cwd:join(home,"external")});
    await Bun.sleep(5000);
    assert.equal(sessionFor(thread.id),null);
    const after=await (await fetch(fixture+"/proof")).json();
    assert.equal(after.requests.filter((r:{client:string})=>["trellis-adopt","trellis-project"].includes(r.client)).length,count);
    assert.deepEqual(JSON.parse(await api("/api/as/adoption")),{enabled:false});
    console.log("PASS: adopt off makes zero requests and zero adoptions");
  }
} finally {db.close();}
