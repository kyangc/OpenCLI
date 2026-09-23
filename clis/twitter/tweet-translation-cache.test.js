import {describe,it,expect} from 'vitest';import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {TranslationCache,translationKey} from './tweet-translation-cache.js';import {sessionScope} from './tweet-session.js';
describe('session-isolated translation cache',()=>{
 it('returns an opaque identifier that rotates with login and rejects missing credentials',()=>{
  const scope=sessionScope([{name:'auth_token',value:'private-cookie-a'},{name:'ct0',value:'csrf'}]);expect(scope).toMatch(/^[0-9a-f]{64}$/);expect(scope).not.toContain('private');expect(scope).not.toBe(sessionScope([{name:'auth_token',value:'private-cookie-b'},{name:'ct0',value:'csrf'}]));expect(()=>sessionScope([])).toThrow(/login/);
 });
 it('invalidates by source, account and expiry and does not cache failures or partial text',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'x-cache-'));try{
   const cache=new TranslationCache(dir),post={id:'1',text:'hello',lang:'en'};const key=translationKey('scope',post);const value={status:'translated',text:'你好',target_lang:'zh-CN',completeness:'unknown'};
   await cache.set(key,value);expect(await cache.get(key)).toEqual(value);expect(await cache.get(translationKey('other',post))).toBeNull();expect(await cache.get(translationKey('scope',{...post,text:'changed'}))).toBeNull();expect(await cache.get(key,Date.now()+8*86400_000)).toBeNull();
   await cache.set('failure',{status:'unavailable'});expect(await cache.get('failure')).toBeNull();await cache.set('partial',{...value,completeness:'partial'});expect(await cache.get('partial')).toBeNull();expect(await readFile(path.join(dir,key+'.json'),'utf8')).not.toContain('private-cookie');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
