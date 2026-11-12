// Called by the Worker after it authorizes a Source check for this child.
export async function fetchSourceObservation(env, childId, fetchRunner = fetch) {
  const unavailable = (reason) => ({ status: 'unavailable', reason });
  const id = /^[a-z0-9][a-z0-9-]{0,39}$/;
  if (typeof childId !== 'string' || !id.test(childId)) return unavailable('invalid_child');
  let url;
  try { url = new URL(env.SOURCE_RUNNER_URL); }
  catch { return unavailable('runner_not_configured'); }
  const { SOURCE_RUNNER_TOKEN: token, SOURCE_ACCESS_CLIENT_ID: accessId,
    SOURCE_ACCESS_CLIENT_SECRET: accessSecret } = env;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/v1/source/check' || !/^[a-f0-9]{64}$/.test(token ?? '') ||
      !accessId || !accessSecret) {
    return unavailable('runner_not_configured');
  }

  try {
    const response = await fetchRunner(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(95000),
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'CF-Access-Client-Id': accessId, 'CF-Access-Client-Secret': accessSecret,
      },
      body: JSON.stringify({ version: 1, childId }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable(response.status === 409 ? 'runner_busy' : 'runner_failed');
    }
    const { status, observation } = await response.json();
    if (status !== 'ok' || observation?.version !== 1 || observation.provider !== 'source' ||
        observation.childId !== childId || !Number.isFinite(Date.parse(observation.observedAt)) ||
        !Array.isArray(observation.courses) || observation.courses.length === 0 ||
        !observation.courses.every(course => typeof course?.course === 'string' &&
          (course.missing === null || Array.isArray(course.missing))) ||
        !Array.isArray(observation.attendance?.absences) || !Array.isArray(observation.attendance?.tardies)) {
      return unavailable('invalid_runner_response');
    }
    return { status: 'ok', observation };
  } catch {
    return unavailable('runner_failed');
  }
}
