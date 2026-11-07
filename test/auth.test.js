import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedCredentialDestination, guardLoginRequest } from '../src/auth.js';
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
test('Schoology passwords are restricted to its exact HTTPS login endpoint',async()=>{
  assert.equal(allowedCredentialDestination('schoology','https://app.schoology.com/login?destination=parent%2Fhome'),true);
  for (const url of ['http://app.schoology.com/login','https://app.schoology.com.evil.invalid/login',
    'https://app.schoology.com/assignment/123','https://outside.invalid/login']) {
    const route=routeFor(url);
    assert.equal(await guardLoginRequest(route,'schoology'),false);
    assert.equal(route.state.fetched,false);
  }
  assert.equal(allowedCredentialDestination('unknown','https://app.schoology.com/login'),false);
});
test('Schoology cannot redirect password submissions to SSO or a new host',async()=>{
  const route=routeFor('https://app.schoology.com/login',307,'https://login.example.invalid/');
  assert.equal(await guardLoginRequest(route,'schoology'),false);
  assert.equal(route.state.aborted,true);
});
test('Schoology dashboard static assets can load without widening credential destinations',async()=>{
  const url='https://asset-cdn.schoology.com/assets/bundles/js/header.js';
  const read=routeFor(url);read.request=()=>({url:()=>url,method:()=> 'GET'});
  assert.equal(await guardLoginRequest(read,'schoology'),true);
  assert.equal(read.state.fetched,false);
  const write=routeFor(url);
  assert.equal(await guardLoginRequest(write,'schoology'),false);
  assert.equal(write.state.aborted,true);
  assert.equal(write.state.fetched,false);
});
