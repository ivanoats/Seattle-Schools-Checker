const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
const nonempty = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const validSourceHref = value => typeof value === 'string'
  && /^\/guardian\/[^\s"'\\<>]+$/.test(value);

function requireValid(condition) {
  if (!condition) throw new Error('invalid_child_config');
}

function validateOptionalFields(value, validators) {
  for (const [field, validate] of Object.entries(validators)) {
    if (value[field] !== undefined) requireValid(validate(value[field]));
  }
}

function validateSource(source, headings) {
  requireValid(nonempty(source.tabLabel) && nonempty(source.studentHeading));
  validateOptionalFields(source, {
    tabSwitchId: value => typeof value === 'string' && /^\d{1,12}$/.test(value),
    tabId: value => /^[a-zA-Z][a-zA-Z0-9_-]{0,100}$/.test(value),
    tabHref: validSourceHref,
    term: nonempty,
  });
  requireValid(!headings.has(source.studentHeading));
  headings.add(source.studentHeading);
}

function validateSchoology(schoology, banners) {
  requireValid(nonempty(schoology.banner) && schoology.banner.startsWith('You are viewing as '));
  validateOptionalFields(schoology, {
    selectionHref: value => /^\/parent\/(?:index\?child=\d+|switch_child\/\d+)$/.test(value),
  });
  requireValid(!banners.has(schoology.banner));
  banners.add(schoology.banner);
}

export function configuredChild(config, childId) {
  requireValid(config && Array.isArray(config.children) && validId(config.defaultChild));
  const children = new Map();
  const sourceHeadings = new Set();
  const schoologyBanners = new Set();
  for (const child of config.children) {
    requireValid(validId(child?.id));
    requireValid(nonempty(child.displayName) && !children.has(child.id));
    const { source, schoology } = child.providers ?? {};
    requireValid(source || schoology);
    if (source) validateSource(source, sourceHeadings);
    if (schoology) validateSchoology(schoology, schoologyBanners);
    children.set(child.id, child);
  }
  requireValid(children.has(config.defaultChild));
  const selected = children.get(childId ?? config.defaultChild);
  if (!selected) throw new Error('child_not_configured');
  return selected;
}
