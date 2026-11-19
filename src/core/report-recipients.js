export const maxReportRecipients = 10;

function emailAddress(value) {
  if (typeof value !== 'string') throw new Error('invalid_email_address');
  const address = value.trim();
  if (address.length > 254 || /[\s<>(),;:\[\]\\"]/.test(address)) throw new Error('invalid_email_address');
  const parts = address.split('@');
  if (parts.length !== 2) throw new Error('invalid_email_address');
  const [local, domain] = parts;
  if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+$/.test(local)) throw new Error('invalid_email_address');
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) {
    throw new Error('invalid_email_address');
  }
  return `${local}@${domain.toLowerCase()}`;
}

// Preserve a person's spelling while deduplicating the ordinary mailbox form.
// Header syntax and display names are excluded; callers pass address-only data.
export function normalizeReportRecipients(values) {
  if (!Array.isArray(values) || values.length > maxReportRecipients) throw new Error('too_many_recipients');
  const seen = new Set(); const recipients = [];
  for (const value of values) {
    const address = emailAddress(value); const key = address.toLowerCase();
    if (!seen.has(key)) { seen.add(key); recipients.push(address); }
  }
  return recipients;
}
