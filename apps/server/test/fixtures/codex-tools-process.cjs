const readline=require('node:readline');
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');let thread=0;const pending=new Map();
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),reply=value=>send({id:r.id,result:value});
 if(r.method==='initialize'){if(r.params.capabilities?.experimentalApi!==true)throw Error('missing experimental handshake');return reply({});}
 if(r.method==='initialized')return;
 if(r.method==='account/read')return reply({account:{type:'chatgpt'}});
 if(r.method==='thread/start'){if(!r.params.dynamicTools?.length||r.params.config.features.shell_tool!==false||r.params.sandbox!=='read-only')throw Error('invalid tool config');return reply({thread:{id:'thread-'+ ++thread}});}
 if(r.method==='turn/start'){
  const threadId=r.params.threadId,turnId='turn-'+threadId,id=100+thread;reply({turn:{id:turnId}});pending.set(id,{threadId,turnId});
  send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'comment',delta:'Reading the file.'}});
  send({method:'item/started',params:{threadId,turnId,item:{id:'tool',type:'dynamicToolCall'}}});
  send({id,method:'item/tool/call',params:{threadId,turnId,callId:'call-'+thread,namespace:null,tool:'files_read',arguments:{path:'a.txt'}}});return;
 }
 if(r.method==='turn/interrupt'){send({method:'item/agentMessage/delta',params:{threadId:r.params.threadId,delta:'late output'}});reply({});return send({method:'turn/completed',params:{threadId:r.params.threadId,turn:{id:r.params.turnId,status:'interrupted'}}});}
 if(r.method==='thread/unsubscribe'||r.method==='thread/archive')return reply({});
 if(r.id&&r.result&&pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);if(!r.result.contentItems?.[0]?.text)throw Error('invalid tool response');send({method:'thread/tokenUsage/updated',params:{threadId:p.threadId,tokenUsage:{last:{inputTokens:10},total:{inputTokens:20}}}});send({method:'item/completed',params:{...p,item:{id:'comment-only',type:'agentMessage',phase:'commentary',text:'Checking the result.'}}});send({method:'item/agentMessage/delta',params:{...p,itemId:'final',delta:'Final answer.'}});return send({method:'turn/completed',params:{threadId:p.threadId,turn:{id:p.turnId,status:'completed'}}});}
 if(r.method)reply({});
});
