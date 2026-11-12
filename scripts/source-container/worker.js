import { DurableObject } from 'cloudflare:workers';
import { createHash, timingSafeEqual } from 'node:crypto';

const headers = { 'Cache-Control': 'no-store' };
const hash = value => createHash('sha256').update(value).digest();

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/probe') {
      return new Response(null, { status: 404, headers });
    }
    const supplied = request.headers.get('Authorization') ?? '';
    const token = env.PROBE_TOKEN;
    if (typeof token !== 'string' || token.length < 32 ||
        !timingSafeEqual(hash(supplied), hash(`Bearer ${token}`))) {
      return new Response(null, { status: 404, headers });
    }
    return env.PROBE.getByName('source-login-form').fetch('http://probe/probe', { method: 'POST' });
  },
};

export class SourceProbe extends DurableObject {
  async fetch() {
    // Use one container and allow only one in-flight probe.
    if (this.running) return Response.json({ result: 'probe_already_running' }, { status: 409, headers });
    this.running = true;
    const container = this.ctx.container;
    try {
      if (!container.running) {
        container.start({ image: container.images.base, instance: 'basic', enableInternet: true });
      }
      await container.setInactivityTimeout(60000);
      const port = container.getTcpPort(8080);
      for (let attempt = 0; attempt < 60; attempt++) {
        let ready = false;
        try {
          const response = await port.fetch('http://container/health', { signal: AbortSignal.timeout(1000) });
          ready = response.ok;
          await response.body?.cancel();
        } catch { /* Container start is asynchronous. */ }
        if (ready) {
          const result = await port.fetch('http://container/probe', {
            method: 'POST', signal: AbortSignal.timeout(55000),
          });
          return Response.json(await result.json(), { status: result.status, headers });
        }
        await scheduler.wait(500);
      }
      return Response.json({ result: 'container_start_timeout' }, { status: 504, headers });
    } catch {
      return Response.json({ result: 'container_probe_failed' }, { status: 502, headers });
    } finally {
      this.running = false;
    }
  }
}
