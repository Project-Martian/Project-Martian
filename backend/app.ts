import { buildApp } from './application.js';

const app=await buildApp();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void app.close();});
await app.listen({host:process.env.HOST||'127.0.0.1',port:Number(process.env.PORT||8766)});
console.log('Project Martian Node service listening');
