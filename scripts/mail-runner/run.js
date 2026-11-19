import { pathToFileURL } from 'node:url';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { discoveryEndpoint } from '../source-runner/discover.js';
import { normalizeReportRecipients } from '../../src/core/report-recipients.js';

function validMessage(message) {
  if (!message || Object.keys(message).sort().join(',') !== 'bcc,from,html,subject,text') return false;
  try {
    if (normalizeReportRecipients([message.from]).length !== 1 || !normalizeReportRecipients(message.bcc).length) return false;
  } catch { return false; }
  return typeof message.subject==='string' && message.subject.length<=500 && !/[\r\n]/.test(message.subject)
    && typeof message.text==='string' && typeof message.html==='string'
    && new TextEncoder().encode(message.text+message.html).length<=512000;
}

function validJob(job, now) {
  return ['daily','test'].includes(job?.kind) && /^[a-f0-9]{64}$/.test(job?.lease ?? '')
    && Date.parse(job.expiresAt)>now && Date.parse(job.expiresAt)<=now+130000 && validMessage(job.message);
}

export async function runHostedMail({origin,token,client,request=fetch,clock=Date.now}) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) return {status:'not_configured'};
  const endpoint=action=>discoveryEndpoint(origin,action).replace('/discovery/source/','/report-email/');
  const post=(action,body)=>request(endpoint(action),{method:'POST',redirect:'error',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  let job=null;
  try {
    const response=await post('claim',{});
    if (!response.ok) return {status:'claim_unavailable'};
    const data=await response.json(); if (data.status==='idle') return {status:'idle'};
    job=data.job;
    if (!validJob(job,clock())) return {status:'invalid_job'};
    const {message,...identity}=job;
    const allowed=await post('authorize',identity);
    if (!allowed.ok || (await allowed.json()).status!=='authorized') return {status:'authorization_changed'};
    let state='unknown'; let messageId=null;
    try {
      const result=await client.send(new SendEmailCommand({FromEmailAddress:message.from,Destination:{BccAddresses:message.bcc},
        Content:{Simple:{Subject:{Data:message.subject,Charset:'UTF-8'},Body:{Text:{Data:message.text,Charset:'UTF-8'},Html:{Data:message.html,Charset:'UTF-8'}}}}}),
      {abortSignal:AbortSignal.timeout(30000)});
      if (typeof result.MessageId==='string' && /^[a-zA-Z0-9-]{1,200}$/.test(result.MessageId)) {state='sent';messageId=result.MessageId;}
    } catch(error) {
      if (error.name==='TooManyRequestsException') state='retry';
      else if (['MessageRejected','MailFromDomainNotVerifiedException','BadRequestException','AccountSuspendedException','SendingPausedException','AccessDeniedException'].includes(error.name)) state='failed';
    }
    if (job.kind==='test' && state==='retry') state='failed';
    const completion=await post('complete',{...identity,state,messageId});
    return {status:completion.ok?state:'completion_unverified'};
  } catch {return {status:'delivery_unverified'};}
  finally {if(job)job.message=null;}
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  // One request only: SDK retries could duplicate an ambiguously accepted send.
  const client=new SESv2Client({region:process.env.AWS_REGION ?? 'us-west-2',maxAttempts:1});
  try {
    const result=await runHostedMail({origin:process.env.DISCOVERY_APP_ORIGIN,token:process.env.SOURCE_DISCOVERY_TOKEN,client});
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!['idle','sent'].includes(result.status)) process.exitCode=1;
  } finally {client.destroy();}
}
