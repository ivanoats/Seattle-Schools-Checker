import { createRemoteJWKSet, jwtVerify } from 'jose';

const keySets = new Map();

export function accessConfig(env) {
  const team = env.ACCESS_TEAM_DOMAIN;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team ?? '') ||
      typeof env.ACCESS_AUD !== 'string' || !env.ACCESS_AUD.trim()) return null;
  return { issuer: `https://${team}`, audience: env.ACCESS_AUD };
}

// Do not trust an email header, a client-supplied family ID, or decoded JWT claims.
export async function accessIdentity(request, env, options = {}) {
  const config = accessConfig(env);
  if (!config) throw new Error('access_not_configured');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16384) return null;
  if (!keySets.has(config.issuer)) {
    keySets.set(config.issuer, createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`)));
  }
  try {
    const { payload } = await jwtVerify(token, options.keySet ?? keySets.get(config.issuer), {
      ...config, algorithms: ['RS256'], requiredClaims: ['sub', 'email', 'exp', 'iat'],
      ...(options.now ? { currentDate: new Date(options.now) } : {}),
    });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256 ||
        typeof payload.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) ||
        payload.email.length > 254) return null;
    return { subject: payload.sub, email: payload.email.toLowerCase() };
  } catch { return null; }
}
