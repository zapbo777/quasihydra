// Original self-contained Node server, no third-party dependencies.
// Default is local-only and does NOT call or bill OpenAI until explicitly configured.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const host=process.env.HOST || '127.0.0.1';
const port=Number(process.env.PORT || 5187);
const model=process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const configured=Boolean(process.env.OPENAI_API_KEY);
const quotas=new Map();
function reply(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function throttle(ip){const now=Date.now();let st=quotas.get(ip)||{count:0,reset:now+60000};if(now>st.reset)st={count:0,reset:now+60000};st.count++;quotas.set(ip,st);return st.count<=8;}
async function readJSON(req){let bytes=0;const parts=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>12000)throw new Error('Input is too long');parts.push(chunk)}return JSON.parse(Buffer.concat(parts).toString('utf8'))}
function clean(obj){const allowed=['brand','offer','audience','pain','benefit','proof','platform','length','cta','site'];const out={};for(const key of allowed)out[key]=String(obj?.[key]??'').trim().slice(0,300);if(!out.offer)throw new Error('Product/service is required');return out;}
function makePrompt(data){return `Prepare exactly 20 distinctive video-opening hooks for a social media advertiser. Return ONLY a JSON object with a "hooks" array. Each hook has "category" and "text" as strings. Categories should rotate among Curiosity, Problem/Solution, POV, Storytelling, Specificity. Keep claims conservative, no invented testimonials, no unverified earnings, no promises of guaranteed results. Make hooks short, punchy and audience-specific. Context: ${JSON.stringify(data)}. No HTML and no additional explanation.`}
async function liveHooks(data){
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),35000);
 try{
  const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model,input:[{role:'user',content:makePrompt(data)}],max_output_tokens:1500,store:false})});
  const raw=await r.text();if(!r.ok)throw new Error(`AI provider returned ${r.status}; check credentials, quota or model access`);
  const obj=JSON.parse(raw);let output=(obj.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text||'').join('\n')||obj.output_text||'';
  output=output.trim().replace(/^```(?:json)?/,'').replace(/```$/,'').trim();
  let result=JSON.parse(output);if(!Array.isArray(result.hooks))throw new Error('AI response missing hooks');
  result.hooks=result.hooks.filter(x=>x&&typeof x.text==='string'&&x.text.trim()).slice(0,20).map(x=>({category:String(x.category||'AI idea').slice(0,40),text:x.text.trim().slice(0,280)}));
  return result;
 }finally{clearTimeout(timer)}
}
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/api/health')return reply(res,200,{aiConfigured:configured,mode:configured?'optional-ai':'free-local',service:'QUASI Business Creative Studio'});
  if(req.method==='POST'&&url.pathname==='/api/hooks'){
   if(!configured)return reply(res,503,{error:'AI is not enabled. Use the free generator, which needs no billing.'});
   if(!throttle(req.socket.remoteAddress||'local'))return reply(res,429,{error:'Too many requests; try again later.'});
   let data;try{data=clean(await readJSON(req))}catch(e){return reply(res,400,{error:e.message})}
   try{return reply(res,200,await liveHooks(data))}catch(e){return reply(res,502,{error:e.message})}
  }
  if(req.method!=='GET')return reply(res,405,{error:'Method not allowed'});
  const paths={'/':'index.html','/index.html':'index.html','/studio.html':'studio.html'};
  const file=paths[url.pathname];if(!file)return reply(res,404,{error:'Not found'});
  const body=await readFile(path.join(here,file));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self' 'unsafe-inline' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(body);
 }catch(e){reply(res,500,{error:'Server error'})}
}).listen(port,host,()=>console.log(`QUASI local preparation on http://${host}:${port} (AI ${configured?'optional enabled':'disabled'})`));
