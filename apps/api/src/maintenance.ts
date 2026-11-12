import { existsSync,openSync,writeSync,closeSync,readFileSync,unlinkSync,mkdirSync,renameSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { DatabaseSync,backup } from 'node:sqlite';
import { Store,now } from '../../../packages/database/src/index.ts';
export function acquireLock(database:string){
 mkdirSync(dirname(database),{recursive:true,mode:0o700});const path=database+'.lock';
 if(existsSync(path)){const pid=Number(readFileSync(path,'utf8'));try{process.kill(pid,0);throw Error('Database in uso: fermare applicazione e comandi amministrativi');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;unlinkSync(path);}}
 const fd=openSync(path,'wx',0o600);writeSync(fd,String(process.pid));closeSync(fd);return ()=>{if(existsSync(path)&&readFileSync(path,'utf8')===String(process.pid))unlinkSync(path);};
}
export async function restoreOffline(database:string,source:string){
 if(resolve(database)===resolve(source))throw Error('Sorgente e destinazione coincidono');
 const unlock=acquireLock(database);let src:DatabaseSync|undefined;const temp=database+'.restoring';
 try{
  src=new DatabaseSync(source,{readOnly:true});if(src.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw Error('Backup corrotto');
  const version=src.prepare('SELECT MAX(version) version FROM migrations').get()?.version;if(version!==1)throw Error('Versione schema non compatibile');
  if(src.prepare('PRAGMA foreign_key_check').all().length)throw Error('Foreign key non valide');
  if(existsSync(database)){const current=new Store(database);try{await current.backup(database+'.pre-restore-'+Date.now()+'.sqlite');}finally{current.close();}}
  if(existsSync(temp))unlinkSync(temp);await backup(src,temp);src.close();src=undefined;
  for(const suffix of ['-wal','-shm'])if(existsSync(database+suffix))unlinkSync(database+suffix);
  renameSync(temp,database);const result=new Store(database);result.audit(null,'backup.restore',null,{schemaVersion:1,at:now()});result.close();
 }finally{src?.close();if(existsSync(temp))unlinkSync(temp);unlock();}
}
