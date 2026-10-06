import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getWindow, normalizeSnapshot, aggregateMonths, collectProfile, renderProfile,
  languageShares, escapeXml, graphqlRequest,
} from './generate-profile.mjs';

const username = 'HYHBalci';
const now = new Date('2026-10-06T12:34:56.000Z');

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1, username, generatedAt: now.toISOString(),
    window: { startDate: '2025-10-07', endDate: '2026-10-06' },
    activity: { commits: 0, pullRequests: 0, issues: 0, reviews: 0, days: [] },
    publicProfile: { repositories: 0, followers: 0, stars: 0 },
    code: { repositories: 0, languages: [] },
    ...overrides,
  };
}

function connection(nodes, cursor = null) {
  return { nodes, totalCount: nodes.length, pageInfo: { hasNextPage: Boolean(cursor), endCursor: cursor } };
}

function languageConnection(languages, cursor = null) {
  return {
    edges: languages.map(([name, size]) => ({ size, node: { name } })),
    pageInfo: { hasNextPage: Boolean(cursor), endCursor: cursor },
  };
}

function repository(id, extra = {}) {
  return {
    id, name: id, owner: { login: username }, isPrivate: false, isFork: false,
    isArchived: false, stargazerCount: 0, languages: languageConnection([]), ...extra,
  };
}

function user(repositories) {
  return {
    login: username, followers: { totalCount: 12 }, repositories,
    contributionsCollection: {
      totalCommitContributions: 2, totalPullRequestContributions: 1,
      totalIssueContributions: 0, totalPullRequestReviewContributions: 0,
      contributionCalendar: { weeks: [{ contributionDays: [
        { date: '2025-10-06', contributionCount: 99 },
        { date: '2025-10-07', contributionCount: 2 },
        { date: '2026-10-06', contributionCount: 1 },
      ] }] },
    },
  };
}

function mockApi(handler) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.github.com/graphql');
      const body = JSON.parse(options.body);
      calls.push(body);
      return { ok: true, status: 200, json: async () => ({ data: handler(body) }) };
    },
  };
}

test('trailing UTC year handles leap day and preserves a precise inclusive window', () => {
  const leap = getWindow(new Date('2024-02-29T23:59:59.000Z'));
  assert.equal(leap.startDate, '2023-03-01');
  assert.equal(leap.endDate, '2024-02-29');
  assert.equal(normalizeSnapshot(snapshot({ window: leap })).activity.days.length, 366);
  const normal = getWindow(new Date('2025-03-01T00:01:00.000Z'));
  assert.equal(normal.startDate, '2024-03-02');
  assert.equal(normalizeSnapshot(snapshot({ window: normal })).activity.days.length, 365);
  assert.deepEqual(getWindow(now), {
    startDate: '2025-10-07', endDate: '2026-10-06',
    from: '2025-10-07T00:00:00.000Z', to: now.toISOString(),
  });
});

test('monthly bins cover 13 calendar months, mark both partial endpoints, and preserve exact totals', () => {
  const normalized = normalizeSnapshot(snapshot({ activity: {
    commits: 7, pullRequests: 0, issues: 0, reviews: 0,
    days: [{ date: '2025-10-07', count: 2 }, { date: '2026-01-01', count: 4 }, { date: '2026-10-06', count: 1 }],
  } }));
  const months = aggregateMonths(normalized.activity.days, normalized.window.startDate, normalized.window.endDate);
  assert.equal(months.length, 13);
  assert.deepEqual(months.filter(month => month.partial).map(month => month.month), ['2025-10', '2026-10']);
  assert.equal(months.reduce((sum, month) => sum + month.count, 0), 7);
  assert.equal(months[3].label, 'Jan');
  assert.equal(months[3].count, 4);
  assert.equal(months[1].count, 0);
});

test('repository and language pagination retain every eligible public byte, with accurate exclusions', async () => {
  const original = repository('original', { stargazerCount: 7, languages: languageConnection([['TypeScript', 100]]) });
  const fork = repository('fork', { isFork: true, stargazerCount: 999, languages: languageConnection([['Fork language', 999]]) });
  const archived = repository('archived', { isArchived: true, stargazerCount: 21, languages: languageConnection([['Archived language', 999]]) });
  const profile = repository('profile', { name: username, stargazerCount: 999, languages: languageConnection([['Profile language', 999]]) });
  const second = repository('second', { stargazerCount: 2, languages: languageConnection([['JavaScript', 150], ['Ruby', 50]], 'language-2') });
  const privateRepo = repository('do-not-save-this-private-name', { isPrivate: true, stargazerCount: 999 });
  const foreign = repository('foreign', { owner: { login: 'SomeoneElse' }, stargazerCount: 999 });
  const unknownPrivacy = repository('unknown', { isPrivate: undefined, stargazerCount: 999 });
  const api = mockApi(({ query, variables }) => {
    if (query.includes('query Profile(')) {
      assert.match(query, /ownerAffiliations: \[OWNER\], privacy: PUBLIC/);
      assert.equal(variables.from, '2025-10-07T00:00:00.000Z');
      return { user: user(connection([original, fork, archived, profile, privateRepo, foreign, unknownPrivacy], 'repository-2')) };
    }
    if (query.includes('query RepositoryPage(')) {
      assert.match(query, /ownerAffiliations: \[OWNER\], privacy: PUBLIC/);
      assert.equal(variables.after, 'repository-2');
      return { user: { repositories: connection([second, original]) } };
    }
    assert.match(query, /query LanguagePage/);
    assert.equal(variables.id, 'second');
    assert.equal(variables.after, 'language-2');
    return { node: { isPrivate: false, owner: { login: username }, languages: languageConnection([['PHP', 100], ['TypeScript', 100]]) } };
  });
  const result = await collectProfile({ username, token: 'fake-token-for-mock', fetchImpl: api.fetchImpl, now });
  assert.equal(api.calls.length, 3);
  assert.deepEqual(result.publicProfile, { repositories: 5, followers: 12, stars: 30 });
  assert.equal(result.code.repositories, 2);
  assert.deepEqual(result.code.languages, [
    { name: 'TypeScript', bytes: 200 }, { name: 'JavaScript', bytes: 150 },
    { name: 'PHP', bytes: 100 }, { name: 'Ruby', bytes: 50 },
  ]);
  assert.equal(result.activity.totalContributions, 3);
  assert.equal(result.activity.days.length, 365);
  assert.doesNotMatch(JSON.stringify(result), /do-not-save-this-private-name|Fork language|Archived language|Profile language|fake-token/);
});

test('a repository becoming private while language pages load contributes no language bytes', async () => {
  const repo = repository('changing', { languages: languageConnection([['Do not publish', 100]], 'next') });
  const api = mockApi(({ query }) => query.includes('query Profile(')
    ? { user: user(connection([repo])) }
    : { node: { isPrivate: true, owner: { login: username }, languages: languageConnection([['Secret', 100]]) } });
  const result = await collectProfile({ username, token: 'mock', fetchImpl: api.fetchImpl, now });
  assert.deepEqual(result.code, { repositories: 0, languages: [] });
});

test('repeated repository cursors fail explicitly instead of looping or silently truncating', async () => {
  const api = mockApi(({ query }) => query.includes('query Profile(')
    ? { user: user(connection([], 'same')) }
    : { user: { repositories: connection([], 'same') } });
  await assert.rejects(collectProfile({ username, token: 'mock', fetchImpl: api.fetchImpl, now }), /repeated pagination cursor/);
  assert.equal(api.calls.length, 2);
});

test('zero activity and languages produce twelve finite, accessible SVGs with honest empty states', () => {
  const assets = renderProfile(snapshot());
  assert.equal(Object.keys(assets).length, 12);
  for (const [file, markup] of Object.entries(assets)) {
    assert.match(markup, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(markup, /role="img" aria-labelledby="title desc"/);
    assert.match(markup, /<title id="title">/);
    assert.match(markup, /<desc id="desc">/);
    assert.match(markup, /Updated 2026-10-06 12:34 UTC/);
    assert.doesNotMatch(markup, /NaN|Infinity|undefined/);
    if (file.endsWith('-mobile.svg')) assert.match(markup, /width="480".*viewBox="0 0 480/);
    else assert.match(markup, /width="960".*viewBox="0 0 960/);
    if (file.startsWith('activity-')) assert.match(markup, /No visible contributions/);
    if (file.startsWith('languages-')) assert.match(markup, /No language data in eligible/);
  }
});

test('XML hostile language names and control characters cannot inject SVG markup', () => {
  const hostile = '<script onload="alert(1)">A&B\u0001</script>';
  const assets = renderProfile(snapshot({ code: { repositories: 1, languages: [{ name: hostile, bytes: 100 }] } }));
  const markup = assets['languages-light.svg'];
  assert.doesNotMatch(markup, /<script|\u0001/);
  assert.match(markup, /&lt;script onload=&quot;alert\(1\)&quot;&gt;A&amp;B/);
  assert.equal(escapeXml(`<&>"'\u0000`), '&lt;&amp;&gt;&quot;&apos;');
});

test('language percentages represent all bytes, with top six and a faithful Other bucket', () => {
  const shares = languageShares(Array.from({ length: 8 }, (_, index) => ({ name: `Language ${index}`, bytes: (index + 1) * 100 })));
  assert.equal(shares.length, 7);
  assert.deepEqual(shares.at(-1), { name: 'Other', bytes: 300, percentage: 300 / 3600 * 100 });
  assert.ok(Math.abs(shares.reduce((sum, item) => sum + item.percentage, 0) - 100) < 1e-9);
});

test('offline snapshots reject corrupt dates, inconsistent totals, duplicate days and negative bytes', () => {
  assert.throws(() => normalizeSnapshot(snapshot({ window: { startDate: '2025-02-30', endDate: '2026-01-01' } })), /Invalid UTC date/);
  assert.throws(() => normalizeSnapshot(snapshot({ activity: { commits: 0, pullRequests: 0, issues: 0, reviews: 0, totalContributions: 99, days: [] } })), /does not match/);
  assert.throws(() => normalizeSnapshot(snapshot({ activity: { commits: 0, pullRequests: 0, issues: 0, reviews: 0, days: [{ date: '2026-01-01', count: 1 }, { date: '2026-01-01', count: 1 }] } })), /Duplicate activity date/);
  assert.throws(() => normalizeSnapshot(snapshot({ code: { repositories: 1, languages: [{ name: 'JS', bytes: -1 }] } })), /nonnegative count/);
  const clean = normalizeSnapshot({ ...snapshot(), privateRepositoryName: 'must-not-persist' });
  assert.equal(clean.privateRepositoryName, undefined);
});

test('API failure and missing authentication fail without including token values', async () => {
  await assert.rejects(graphqlRequest('query { viewer { login } }', {}), /Set GH_TOKEN or GITHUB_TOKEN/);
  await assert.rejects(graphqlRequest('query { viewer { login } }', {}, {
    token: 'do-not-log-this-token', fetchImpl: async () => ({ ok: false, status: 401 }),
  }), error => error.message === 'GitHub API request failed (HTTP 401)');
});
