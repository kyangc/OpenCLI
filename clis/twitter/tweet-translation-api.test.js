import {describe,it,expect,vi} from 'vitest';
import {requestTranslation} from './tweet-translation-api.js';
import {translatePostWithApi,translationPostIds} from './tweet-translation.js';
const post={id:'123',text:'hello',lang:'en'};
const pageFor=response=>({getCookies:async()=>[{name:'ct0',value:'test-secret'}],evaluate:vi.fn().mockResolvedValue(response),goto:vi.fn()});
describe('X direct translation',()=>{
 it('executes authenticated POST without navigation and retains original',async()=>{
  const page=pageFor(null);page.evaluate.mockImplementation(async script=>{
   vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    expect(url).toBe('https://api.x.com/2/grok/translation.json');expect(init.method).toBe('POST');expect(init.credentials).toBe('include');expect(JSON.parse(init.body)).toEqual({content_type:'POST',id:'123',dst_lang:'zh'});
    return {status:200,text:async()=>JSON.stringify({result:{content_type:'POST',text:'你好',entities:{}}})};
   }));try{return await eval(script);}finally{vi.unstubAllGlobals();}
  });
  const result=await translatePostWithApi(page,post);expect(result).toMatchObject({status:'translated',text:'你好',method:'api'});expect(JSON.stringify(result)).not.toContain('test-secret');expect(page.goto).not.toHaveBeenCalled();expect(post.text).toBe('hello');
 });
 it('does not fall back or hammer the UI after throttling or exhausted budget',async()=>{
  const page=pageFor({status:429});expect(await translatePostWithApi(page,post)).toMatchObject({status:'unavailable',reason:'translation_rate_limited'});expect(page.goto).not.toHaveBeenCalled();
  expect(await translatePostWithApi(page,post,{deadline:0})).toMatchObject({reason:'translation_budget_exhausted'});
 });
 it('propagates login expiry',async()=>{await expect(translatePostWithApi(pageFor({status:401}),post)).rejects.toThrow(/login/);});
 it('rejects link-only, wrong content type and non-Chinese successful responses',async()=>{
  for(const result of [{content_type:'POST',text:'https://t.co/test'},{content_type:'ARTICLE',text:'你好'},{content_type:'POST',text:'hello'}])expect(await requestTranslation(pageFor({status:200,body:JSON.stringify({result})}),post)).toMatchObject({fallback:true,reason:'translation_api_invalid'});
 });
 it('falls back within the remaining budget when API shape changes',async()=>{
  const page=pageFor(null);page.evaluate.mockResolvedValueOnce({status:200,body:'{}'}).mockResolvedValue({state:'translated',lang:'zh',text:'你好'});
  expect(await translatePostWithApi(page,post,{deadline:Date.now()+1000})).toMatchObject({method:'dom',text:'你好',fallback_reason:'translation_api_invalid'});expect(page.goto).toHaveBeenCalledOnce();
 });
 it('selects reachable displayed relationships, not hidden descendants',()=>{
  const result={root_id:'1',posts:{'1':{relations:[{kind:'reply',id:'2',state:'resolved'},{kind:'quote',id:'3',state:'resolved'}]},'2':{relations:[{kind:'quote',id:'4',state:'resolved'}]},'3':{relations:[]},'4':{relations:[]}}};
  expect([...translationPostIds(result,'quote')]).toEqual(['1','3']);expect([...translationPostIds(result,'none')]).toEqual(['1']);
 });
});
