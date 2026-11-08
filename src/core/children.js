const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
const nonempty = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const validSourceHref = value => typeof value === 'string'
  && /^\/guardian\/[^\s"'\\<>]+$/.test(value);

export function configuredChild(config, childId) {
  if (!config || !Array.isArray(config.children) || !validId(config.defaultChild)) {
    throw new Error('invalid_child_config');
  }
  const children = new Map();
  const sourceHeadings = new Set();
  const schoologyBanners = new Set();
  for (const child of config.children) {
    if (!validId(child?.id) || !nonempty(child.displayName) || children.has(child.id)) {
      throw new Error('invalid_child_config');
    }
    const { source, schoology } = child.providers ?? {};
    if (!source && !schoology) throw new Error('invalid_child_config');
    if (source) {
      if (!nonempty(source.tabLabel) || !nonempty(source.studentHeading)
          || (source.tabHref !== undefined && !validSourceHref(source.tabHref))
          || (source.term !== undefined && !nonempty(source.term))
          || sourceHeadings.has(source.studentHeading)) {
        throw new Error('invalid_child_config');
      }
      sourceHeadings.add(source.studentHeading);
    }
    if (schoology) {
      if (!nonempty(schoology.banner) || !schoology.banner.startsWith('You are viewing as ')
          || schoologyBanners.has(schoology.banner)) {
        throw new Error('invalid_child_config');
      }
      schoologyBanners.add(schoology.banner);
    }
    children.set(child.id, child);
  }
  if (!children.has(config.defaultChild)) throw new Error('invalid_child_config');
  const selected = children.get(childId ?? config.defaultChild);
  if (!selected) throw new Error('child_not_configured');
  return selected;
}
