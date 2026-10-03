import { request } from 'node:https';
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { readFile } from 'node:fs/promises';

const blocked=new BlockList();
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(ip,prefix,'ipv4');
const global6=new BlockList();global6.addSubnet('2000::',3,'ipv6');
blocked.addSubnet('2001:db8::',32,'ipv6');blocked.addSubnet('2001::',32,'ipv6');blocked.addSubnet('2002::',16,'ipv6');
const publicIP=(ip:string)=>isIP(ip)===4?!blocked.check(ip,'ipv4'):isIP(ip)===6&&global6.check(ip,'ipv6')&&!blocked.check(ip,'ipv6');
export class SourceError extends Error {constructor(public code:string){super(code);}}
export async function secret(name:string) {
  const path=process.env[name];if(!path)throw new SourceError('missing-credential');
  const value=(await readFile(path,'utf8')).trim();if(!value)throw new SourceError('empty-credential');return value;
}
// No redirects, cookies, arbitrary ports, local addresses, or unbounded responses.
// The DNS lookup used by the actual socket is validated (no separate preflight lookup).
export function getText(url:string,headers:Record<string,string>={},body?:string):Promise<string> {
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||u.port||isIP(u.hostname.replace(/^\[|\]$/g,'')))throw new SourceError('invalid-source-url');
  return new Promise((resolve,reject)=>{
    const req=request(u,{method:body?'POST':'GET',headers:{'User-Agent':'ProjectMartianRadar/1.0','Accept-Encoding':'identity',...headers},
      lookup:(hostname,options,callback)=>lookup(hostname,{all:true},(error,addresses)=>{
        if(error){callback(error,'',4);return;}
        if(!addresses.length||addresses.some(a=>!publicIP(a.address))){callback(new SourceError('nonpublic-address'),'',4);return;}
        if(options.all)callback(null,addresses as never);else callback(null,addresses[0].address,addresses[0].family);
      })},res=>{
        if(res.statusCode!==200){res.destroy();reject(new SourceError('http-'+res.statusCode));return;}
        const chunks:Buffer[]=[];let bytes=0;
        res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2000000)req.destroy(new SourceError('response-too-large'));else chunks.push(chunk);});
        res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error',()=>reject(new SourceError('response-error')));
      });
    const deadline=setTimeout(()=>req.destroy(new SourceError('request-timeout')),15000);
    req.on('close',()=>clearTimeout(deadline));
    req.on('error',e=>reject(e instanceof SourceError?e:new SourceError('transport-error')));
    req.end(body);
  });
}
export async function getJson(url:string,headers:Record<string,string>={},body?:string):Promise<any> {
  const text=await getText(url,headers,body);
  try{return JSON.parse(text);}catch{throw new SourceError('invalid-source-json');}
}
