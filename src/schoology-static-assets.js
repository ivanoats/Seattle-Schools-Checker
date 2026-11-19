// External reads needed by Schoology's rendered dashboard. This never permits
// credential submission; callers still restrict methods and the login endpoint.
export function isSchoologyStaticAsset(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.origin === 'https://asset-cdn.schoology.com') return url.pathname.startsWith('/assets/');
    return url.origin === 'https://ui.schoology.com' && !url.search && !url.hash
      && url.pathname.startsWith('/platform/site-navigation-ui/') && /\.(?:js|css)$/.test(url.pathname);
  } catch { return false; }
}
