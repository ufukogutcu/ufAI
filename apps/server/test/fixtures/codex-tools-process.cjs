const readline=require('node:readline');
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');let thread=0;const pending=new Map(),toolKinds=new Map();
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),reply=value=>send({id:r.id,result:value});
 if(r.method==='initialize'){if(r.params.capabilities?.experimentalApi!==true)throw Error('missing experimental handshake');return reply({});}
 if(r.method==='initialized')return;
 if(r.method==='account/read')return reply({account:{type:'chatgpt'}});
 if (r.method === 'thread/start') {
   const { dynamicTools, config, approvalPolicy, sandbox, baseInstructions, developerInstructions } = r.params;
   if (!dynamicTools?.length || config.features.shell_tool !== false || config.features.apply_patch_freeform !== false || approvalPolicy !== 'never' || sandbox !== 'danger-full-access') throw Error('invalid tool config');
   if (baseInstructions?.includes('awareness-fixture')) {
     if (!baseInstructions.includes('Connected agents: {"items":[{"id":"helper"') || !dynamicTools.some(t => t.name === 'agent_connection_inspect')) throw Error('missing connection awareness');
     if (!developerInstructions.includes('agent_send') || !developerInstructions.includes('browser_')) throw Error('missing ufAI messaging and browser guidance');
     if (!/requesting agent "Chief"/.test(baseInstructions) || !/notification/i.test(developerInstructions)) throw Error('missing reply destination or one-way messaging guidance');
     if (!/Final-answer delivery/i.test(developerInstructions) || !developerInstructions.includes('user_notify')) throw Error('missing delivery reminder in Codex developer instructions');
   }
   const id = 'thread-' + ++thread;
   toolKinds.set(id, dynamicTools.some(t => t.name === 'agent_send'));
   return reply({ thread: { id } });
 }
 if(r.method==='turn/start'){
  if(r.params.input[0].text.includes('Inspect') && !r.params.input.some(i=>i.type==='image'&&i.url==='data:image/png;base64,AQID'))throw Error('missing native image');
  const threadId=r.params.threadId,turnId='turn-'+threadId,id=100+thread,text=r.params.input[0].text;reply({turn:{id:turnId}});
  if(text.includes('silent-no-tool'))return send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
  pending.set(id,{threadId,turnId,remaining:text.includes("many-tools")?130:1,awareness:text.includes("awareness-fixture"),silent:text.includes('silent-'),status:text.includes('silent-failed-turn')?'failed':text.includes('silent-interrupted-turn')?'interrupted':'completed',early:text.includes('silent-early-complete')});
  send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'comment',delta:'Reading the file.'}});
  send({method:'item/started',params:{threadId,turnId,item:{id:'tool',type:'dynamicToolCall'}}});
  send({id,method:'item/tool/call',params:{threadId,turnId,callId:'call-'+thread,namespace:null,tool:r.params.input[0].text.includes('yield-fixture')?'task_yield':toolKinds.get(threadId)?'agent_send':'files_read',arguments:r.params.input[0].text.includes('yield-fixture')?{summary:'Waiting for messages'}:toolKinds.get(threadId)?{agentId:'helper',content:'Help'}:{path:'a.txt'}}});
  if(text.includes('silent-early-complete'))send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
  if(r.params.input[0].text.includes('parallel-freeze')){const p=pending.get(id);p.parallelRemaining=2;pending.set(id+10000,p);send({id:id+10000,method:'item/tool/call',params:{threadId,turnId,callId:'parallel-second',tool:'files_read',arguments:{path:'b.txt'}}});}return;
 }
 if(r.method==='turn/interrupt'){send({method:'item/agentMessage/delta',params:{threadId:r.params.threadId,delta:'late output'}});reply({});return send({method:'turn/completed',params:{threadId:r.params.threadId,turn:{id:r.params.turnId,status:'interrupted'}}});}
 if(r.method==='thread/unsubscribe'||r.method==='thread/archive')return reply({});
 if(r.id&&r.result&&pending.has(r.id)){const p=pending.get(r.id);if(p.parallelRemaining && --p.parallelRemaining>0){pending.delete(r.id);return;}
 if (--p.remaining>0) {
   send({id:r.id,method:'item/tool/call',params:{...p,callId:'repeat-'+p.remaining,tool:'files_read',arguments:{path:'a.txt'}}});return;
 }
 pending.delete(r.id);if(!r.result.contentItems?.[0]?.text)throw Error('invalid tool response');if(p.awareness && (JSON.parse(r.result.contentItems[0].text).connectedAgents?.items.length!==0 || r.result.success!==false))throw Error('missing awareness update or changed tool success');if(JSON.parse(r.result.contentItems[0].text).media && !r.result.contentItems.some(i=>i.type==='inputImage'&&i.imageUrl==='data:image/png;base64,AQID'))throw Error('missing dynamic media');send({method:'thread/tokenUsage/updated',params:{threadId:p.threadId,tokenUsage:{last:{inputTokens:10},total:{inputTokens:20}}}});send({method:'item/completed',params:{...p,item:{id:'comment-only',type:'agentMessage',phase:'commentary',text:'Checking the result.'}}});if(p.silent){if(!p.early)send({method:'turn/completed',params:{threadId:p.threadId,turn:{id:p.turnId,status:p.status}}});return;}send({method:'item/agentMessage/delta',params:{...p,itemId:'final',delta:'Final answer.'}});return send({method:'turn/completed',params:{threadId:p.threadId,turn:{id:p.turnId,status:'completed'}}});}
 if(r.method)reply({});
});
