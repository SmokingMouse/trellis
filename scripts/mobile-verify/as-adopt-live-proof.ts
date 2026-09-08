import assert from "node:assert/strict";
import { readFileSync,writeFileSync,realpathSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { AgentClient } from "@smokingmouse/agent-server/client";
import { loadToken } from "@smokingmouse/agent-server/paths";
const home=process.argv[2],mode=process.argv[3],cwd=process.argv[4];
if(!home.startsWith("/tmp/trellis-as-adopt-live-")) throw Error("isolated proof home required");
const file=join(home,"live-proof.json");
const peer=await AgentClient.connectUnix({path:process.env.TRELLIS_AS_SOCKET!,token:loadToken(process.env.TRELLIS_AS_TOKEN_PATH!),client:{name:"trellis-adopt-live-proof",version:"1",kind:"web",label:"收编临时验收"},reconnect:false});
const marker="fj-as-adopt-a06a-live-proof";
try {
  if(mode==="prepare") {
    assert.ok(cwd.includes("/.trellis/scratch/as-adopt-proof-"));
    const {thread}=await peer.request("thread/start",{backend:"claude",model:"sonnet",cwd,permission:"default",clientThreadId:`${marker}-${Date.now()}`,meta:{title:"Trellis 收编临时验收",purpose:marker}});
    writeFileSync(file,JSON.stringify({threadId:thread.id,cwd:realpathSync(cwd),createdThread:thread},null,2));
    console.log(`PASS: created own sonnet proof thread ${thread.id}`);
  } else {
    const proof=JSON.parse(readFileSync(file,"utf8"));
    const {thread}=await peer.request("thread/read",{threadId:proof.threadId});
    // Every write is fenced to the one thread this script created. No discovery
    // result or arbitrary daemon thread ID is ever used for a write.
    assert.equal(thread.cwd,proof.cwd); assert.equal(thread.meta?.purpose,marker);
    assert.ok(thread.clientThreadId?.startsWith(marker));
    if(mode==="close") {
      await peer.request("thread/close",{threadId:thread.id});
      proof.closed=(await peer.request("thread/read",{threadId:thread.id})).thread.status.type;
      assert.equal(proof.closed,"closed");
      writeFileSync(file,JSON.stringify(proof,null,2));
      console.log("PASS: thread/close only the owned temporary thread");
    } else {
      const db=new Database(process.env.TRELLIS_DB_PATH!,{readonly:true});
      try {
        const deadline=Date.now()+10000;
        let row:{session_id:string}|null=null;
        do {row=db.query("SELECT session_id FROM as_adoptions WHERE thread_id=? AND session_id IS NOT NULL").get(thread.id) as {session_id:string}|null;if(row)break;await Bun.sleep(100);}while(Date.now()<deadline);
        assert.ok(row,"live thread did not appear");
        proof.sessionId=row.session_id;
        const headers={"Content-Type":"application/json",Cookie:"trellis_auth=as-adopt-token"};
        const base="http://127.0.0.1:3479";
        const list=await (await fetch(base+"/api/sessions",{headers})).json();
        assert.ok(list.sessions.some((s:{id:string})=>s.id===row!.session_id));
        proof.project=db.query("SELECT p.name,p.cluster_key FROM projects p JOIN workspaces w ON w.project_id=p.id JOIN sessions s ON s.workspace_id=w.id WHERE s.id=?").get(row.session_id);
        assert.equal(proof.project.cluster_key,"trellis:external");
        console.log("PASS: live temporary thread appears in home under 外部会话");
        const response=await fetch(base+"/api/chat",{method:"POST",headers,body:JSON.stringify({kind:"root",sessionId:row.session_id,question:"只回复 TRELLIS_AS_ADOPT_LIVE_OK。不要调用工具，不要读取文件，不要做其他操作。"}),signal:AbortSignal.timeout(120000)});
        const sse=await response.text();writeFileSync(join(home,"live-response.sse"),sse);
        assert.equal(response.status,200,sse);assert.ok(sse.includes('"type":"done"'),sse);
        proof.snapshot=await peer.request("thread/attach",{threadId:thread.id,sinceSeq:0});
        assert.ok(proof.snapshot.items.some((i:{type:string;payload:{text?:string}})=>i.type==="agentMessage"&&i.payload.text?.includes("TRELLIS_AS_ADOPT_LIVE_OK")));
        console.log("PASS: home question answered on the same live daemon thread");
        const deleted=await fetch(base+`/api/sessions/${row.session_id}`,{method:"DELETE",headers});assert.equal(deleted.status,200);
        proof.afterDelete=(await peer.request("thread/read",{threadId:thread.id})).thread;
        assert.notEqual(proof.afterDelete.status.type,"closed");
        console.log("PASS: deleting home session leaves live thread open");
        writeFileSync(file,JSON.stringify(proof,null,2));
      } finally {db.close();}
    }
  }
} finally {peer.close();}
