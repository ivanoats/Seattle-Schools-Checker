import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardLoginRequest } from '../src/auth.js';
function routeFor(url,status=200,location=undefined) {
  const state={aborted:false,fetched:false,fulfilled:null};
  return {state,request:()=>({url:()=>url,method:()=> 'POST'}),
    abort:async()=>{state.aborted=true;},fallback:async()=>{},
    fetch:async options=>{assert.equal(options.maxRedirects,0);state.fetched=true;return {status:()=>status,headers:()=>({location})};},
    fulfill:async value=>{state.fulfilled=value;}};
}
test('unapproved auth hosts are blocked before any data is sent',async()=>{
  const r=routeFor('https://outside.invalid/oauth/token');
  assert.equal(await guardLoginRequest(r,'sugarmate'),false);
  assert.equal(r.state.aborted,true);assert.equal(r.state.fetched,false);
});
test('auth redirects cannot replay a password to another origin',async()=>{
  for(const [status,location]of [[307,'https://outside.invalid/'],[302,'https://outside.invalid/'],[308,'/guardian/home.html']]){
    const r=routeFor('https://ps.seattleschools.org/public/login',status,location);
    assert.equal(await guardLoginRequest(r,'source'),false);assert.equal(r.state.aborted,true);
  }
});
test('safe Source redirects become GET navigations',async()=>{
  const r=routeFor('https://ps.seattleschools.org/public/login',302,'/guardian/home.html');
  assert.equal(await guardLoginRequest(r,'source'),true);assert.equal(r.state.fulfilled.status,303);
});
test('Sugarmate OAuth responses remain local to the browser',async()=>{
  const r=routeFor('https://api.sugarmate.io/oauth/token');
  assert.equal(await guardLoginRequest(r,'sugarmate'),true);assert.ok(r.state.fulfilled.response);
});
