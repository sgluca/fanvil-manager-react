import { hash,argon2id } from 'argon2';
import { randomUUID } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import { Store } from '../../../packages/database/src/index.ts';
import { Secrets } from '../../../packages/fanvil-core/src/index.ts';
import { configFromEnv } from './config.ts';
import { seedDemo } from './services.ts';
import { acquireLock,restoreOffline } from './maintenance.ts';
const [command,arg]=process.argv.slice(2),config=configFromEnv();
try{
 if(command==='restore'){if(!arg)throw Error('Indicare percorso backup');await restoreOffline(config.databasePath,arg);console.log('Ripristino completato');}
 else{
  const unlock=acquireLock(config.databasePath),s=new Store(config.databasePath);
  try{
   if(command==='admin:create'){
    if(!arg||!/^[a-zA-Z0-9_.-]{3,80}$/.test(arg))throw Error('Uso: admin:create nomeutente; password da stdin, almeno 12 caratteri');
    if(process.stdin.isTTY)throw Error('Fornire password tramite stdin senza mostrarla nel terminale');
    const password=readFileSync(0,'utf8').trimEnd();if(password.length<12||password.length>200)throw Error('Password: 12–200 caratteri');
    const id=randomUUID();s.run('INSERT INTO admin_users(id,username,password_hash,role) VALUES(?,?,?,?)',id,arg,await hash(password,{type:argon2id}),'admin');s.audit(null,'admin.bootstrap',id);console.log('Amministratore creato');
   }else if(command==='demo:seed'){if(!config.demo)throw Error('Impostare DEMO_MODE=true');seedDemo(s,new Secrets(config.encryptionKey));console.log('Demo pronta');}
   else if(command==='backup'){if(!arg)throw Error('Indicare percorso backup');s.audit(null,'backup.cli');await s.backup(arg);writeFileSync(arg+'.json',JSON.stringify({schemaVersion:1,createdAt:new Date().toISOString(),requiresOriginalEncryptionKey:true},null,2),{mode:0o600});console.log('Backup e metadati creati');}
   else throw Error('Comandi: admin:create, demo:seed, backup, restore');
  }finally{s.close();unlock();}
 }
}catch(error){console.error(error instanceof Error?error.message:'Comando fallito');process.exitCode=1;}
