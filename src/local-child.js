// The existing install retains its implicit child and portal expectations.
export const legacyChild = Object.freeze({
  id: 'sample',
  displayName: 'Sample Student',
  providers: Object.freeze({
    source: Object.freeze({ tabLabel: 'Sample', studentHeading: 'Student, Sample' }),
    schoology: Object.freeze({ banner: 'You are viewing as Sample Student' }),
  }),
});

export const legacyConfig = { defaultChild: legacyChild.id, children: [legacyChild] };
