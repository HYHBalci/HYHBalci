#!/usr/bin/env node
/**
 * Generate self-hosted SVG profile charts from GitHub's API.
 * Node 20+, no dependencies. Use a repository-scoped GITHUB_TOKEN in Actions:
 * node scripts/generate-profile.mjs --username HYHBalci --output assets
 * For an offline rerender: add --input .local/profile-data.json.
 * Only aggregate contribution counts and PUBLIC repository language bytes are saved.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY_FIELDS = `
  totalCount
  pageInfo { hasNextPage endCursor }
  nodes {
    id name isPrivate isFork isArchived stargazerCount owner { login }
    languages(first: 100, orderBy: { field: SIZE, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      edges { size node { name } }
    }
  }`;

export const PROFILE_QUERY = `query Profile($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    login followers { totalCount }
    repositories(first: 100, ownerAffiliations: [OWNER], privacy: PUBLIC,
      orderBy: { field: NAME, direction: ASC }) { ${REPOSITORY_FIELDS} }
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions totalPullRequestContributions
      totalIssueContributions totalPullRequestReviewContributions
      contributionCalendar { weeks { contributionDays { date contributionCount } } }
    }
  }
}`;

export const REPOSITORIES_QUERY = `query RepositoryPage($login: String!, $after: String!) {
  user(login: $login) {
    repositories(first: 100, after: $after, ownerAffiliations: [OWNER], privacy: PUBLIC,
      orderBy: { field: NAME, direction: ASC }) { ${REPOSITORY_FIELDS} }
  }
}`;

export const LANGUAGES_QUERY = `query LanguagePage($id: ID!, $after: String!) {
  node(id: $id) { ... on Repository {
    isPrivate owner { login }
    languages(first: 100, after: $after, orderBy: { field: SIZE, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      edges { size node { name } }
    }
  } }
}`;

export const THEMES = {
  light: {
    canvas: '#f8faff', paper: '#ffffff', text: '#17334d', muted: '#526b80',
    stroke: '#d7e3ee', blue: '#386fc9', teal: '#218579', coral: '#ce7858',
    palette: ['#386fc9', '#218579', '#ce7858', '#7967af', '#6791a4', '#a4834c', '#8c9cab'],
  },
  dark: {
    canvas: '#122638', paper: '#172e43', text: '#e9f1f8', muted: '#a0b5c8',
    stroke: '#345068', blue: '#82b1ff', teal: '#66c3b1', coral: '#eda082',
    palette: ['#82b1ff', '#66c3b1', '#eda082', '#bbabeb', '#8fbbc9', '#d6bd84', '#8fa5b9'],
  },
};

export function escapeXml(value) {
  // XML 1.0 excludes most control characters, even if escaped.
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const isoDate = date => date.toISOString().slice(0, 10);
const dateValue = value => new Date(`${value}T00:00:00.000Z`);
const nextDay = value => new Date(dateValue(value).getTime() + 86_400_000);
const count = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid nonnegative count: ${label}`);
  return value;
};

/** Inclusive UTC dates covering the trailing calendar year, including today. */
export function getWindow(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid update date');
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const previousYear = end.getUTCFullYear() - 1;
  const lastDay = new Date(Date.UTC(previousYear, end.getUTCMonth() + 1, 0)).getUTCDate();
  const anniversary = new Date(Date.UTC(previousYear, end.getUTCMonth(), Math.min(end.getUTCDate(), lastDay)));
  const start = new Date(anniversary.getTime() + 86_400_000);
  return { startDate: isoDate(start), endDate: isoDate(end), from: start.toISOString(), to: now.toISOString() };
}

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(dateValue(value).getTime()) || isoDate(dateValue(value)) !== value) {
    throw new Error(`Invalid UTC date: ${label}`);
  }
  return value;
}

/** Fill missing days with zero and strip unknown fields from offline snapshots. */
export function normalizeSnapshot(source) {
  if (source?.schemaVersion !== 1) throw new Error('Unsupported snapshot schema; expected schemaVersion 1');
  if (typeof source.username !== 'string' || !source.username.trim()) throw new Error('Snapshot needs a username');
  if (typeof source.generatedAt !== 'string' || !Number.isFinite(new Date(source.generatedAt).getTime())) {
    throw new Error('Snapshot needs a valid generatedAt timestamp');
  }
  const startDate = validDate(source.window?.startDate, 'window.startDate');
  const endDate = validDate(source.window?.endDate, 'window.endDate');
  const span = (dateValue(endDate) - dateValue(startDate)) / 86_400_000;
  if (span < 0 || span > 366) throw new Error('Snapshot window must span at most one year');
  if (!Array.isArray(source.activity?.days)) throw new Error('Snapshot needs activity.days');
  const seenDays = new Map();
  for (const day of source.activity.days) {
    const date = validDate(day.date, 'activity.days.date');
    if (date < startDate || date > endDate) continue;
    if (seenDays.has(date)) throw new Error(`Duplicate activity date: ${date}`);
    seenDays.set(date, count(day.count, 'activity.days.count'));
  }
  const days = [];
  for (let day = dateValue(startDate); isoDate(day) <= endDate; day = nextDay(isoDate(day))) {
    const date = isoDate(day);
    days.push({ date, count: seenDays.get(date) ?? 0 });
  }
  const totalContributions = days.reduce((sum, day) => sum + day.count, 0);
  count(totalContributions, 'activity.totalContributions');
  if (source.activity.totalContributions !== undefined && source.activity.totalContributions !== totalContributions) {
    throw new Error('Snapshot contribution total does not match its daily counts');
  }
  if (!Array.isArray(source.code?.languages)) throw new Error('Snapshot needs code.languages');
  const languages = new Map();
  for (const language of source.code.languages) {
    if (typeof language.name !== 'string' || !language.name.trim()) throw new Error('Invalid language name');
    const bytes = count(language.bytes, 'code.languages.bytes');
    languages.set(language.name, (languages.get(language.name) ?? 0) + bytes);
  }
  return {
    schemaVersion: 1,
    username: source.username,
    generatedAt: new Date(source.generatedAt).toISOString(),
    window: { startDate, endDate },
    activity: {
      totalContributions,
      commits: count(source.activity.commits, 'activity.commits'),
      pullRequests: count(source.activity.pullRequests, 'activity.pullRequests'),
      issues: count(source.activity.issues, 'activity.issues'),
      reviews: count(source.activity.reviews, 'activity.reviews'),
      days,
    },
    publicProfile: {
      repositories: count(source.publicProfile?.repositories, 'publicProfile.repositories'),
      followers: count(source.publicProfile?.followers, 'publicProfile.followers'),
      stars: count(source.publicProfile?.stars, 'publicProfile.stars'),
    },
    code: {
      repositories: count(source.code.repositories, 'code.repositories'),
      languages: [...languages].filter(([, bytes]) => bytes > 0)
        .map(([name, bytes]) => ({ name, bytes }))
        .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name, 'en')),
    },
  };
}

export async function graphqlRequest(query, variables, { token, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('Set GH_TOKEN or GITHUB_TOKEN; a repository-scoped Actions token is sufficient');
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'github-profile-charts' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
      const delay = Math.min(10_000, Math.max(1_000, Number(response.headers?.get('retry-after') ?? 0) * 1_000));
      await new Promise(done => setTimeout(done, delay));
      continue;
    }
    if (!response.ok) throw new Error(`GitHub API request failed (HTTP ${response.status})`);
    const body = await response.json();
    if (body.errors?.length) throw new Error(`GitHub GraphQL: ${body.errors.map(error => error.message).join('; ').slice(0, 500)}`);
    if (!body.data) throw new Error('GitHub API returned no data');
    return body.data;
  }
  throw new Error('GitHub API is temporarily unavailable');
}

function advanceCursor(connection, seen, label) {
  if (!connection?.pageInfo) throw new Error(`Missing pagination information: ${label}`);
  if (!connection.pageInfo.hasNextPage) return null;
  const cursor = connection.pageInfo.endCursor;
  if (!cursor || seen.has(cursor)) throw new Error(`Invalid or repeated pagination cursor: ${label}`);
  seen.add(cursor);
  return cursor;
}

export async function collectProfile({ username, token, fetchImpl = fetch, now = new Date() }) {
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username ?? '')) throw new Error('Provide a valid GitHub username');
  const window = getWindow(now);
  const request = (query, variables) => graphqlRequest(query, variables, { token, fetchImpl });
  const initial = await request(PROFILE_QUERY, { login: username, from: window.from, to: window.to });
  const user = initial.user;
  if (!user) throw new Error(`GitHub user not found: ${username}`);
  const repositories = [];
  let page = user.repositories;
  const repositoryCursors = new Set();
  do {
    if (!Array.isArray(page?.nodes)) throw new Error('GitHub returned no repository connection');
    for (const repository of page.nodes) {
      // Defensive filtering also protects against unexpected API/mocked responses.
      if (repository && repository.isPrivate === false && repository.owner?.login?.toLowerCase() === username.toLowerCase()) {
        repositories.push(repository);
      }
    }
    const after = advanceCursor(page, repositoryCursors, 'repositories');
    if (!after) break;
    const result = await request(REPOSITORIES_QUERY, { login: username, after });
    page = result.user?.repositories;
  } while (true);

  const uniqueRepositories = [...new Map(repositories.map(repository => [repository.id, repository])).values()];
  const originals = uniqueRepositories.filter(repository => !repository.isFork
    && repository.name.toLowerCase() !== username.toLowerCase());
  const languageBytes = new Map();
  let codeRepositoryCount = 0;
  for (const repository of originals.filter(repository => !repository.isArchived)) {
    let languagePage = repository.languages;
    const languageCursors = new Set();
    const repositoryBytes = new Map();
    let stillPublic = true;
    do {
      if (!Array.isArray(languagePage?.edges)) throw new Error('GitHub returned no language connection');
      for (const edge of languagePage.edges) {
        const bytes = count(edge.size, 'GitHub language bytes');
        if (typeof edge.node?.name !== 'string') throw new Error('GitHub returned an invalid language');
        repositoryBytes.set(edge.node.name, (repositoryBytes.get(edge.node.name) ?? 0) + bytes);
      }
      const after = advanceCursor(languagePage, languageCursors, 'languages');
      if (!after) break;
      const result = await request(LANGUAGES_QUERY, { id: repository.id, after });
      const currentRepository = result.node;
      if (!currentRepository || currentRepository.isPrivate !== false
        || currentRepository.owner?.login?.toLowerCase() !== username.toLowerCase()) {
        stillPublic = false;
        break;
      }
      languagePage = currentRepository.languages;
    } while (true);
    if (stillPublic) {
      codeRepositoryCount++;
      for (const [name, bytes] of repositoryBytes) languageBytes.set(name, (languageBytes.get(name) ?? 0) + bytes);
    }
  }

  const collection = user.contributionsCollection;
  if (!collection?.contributionCalendar?.weeks) throw new Error('GitHub returned no contribution calendar');
  return normalizeSnapshot({
    schemaVersion: 1,
    username: user.login,
    generatedAt: now.toISOString(),
    window,
    activity: {
      commits: collection.totalCommitContributions,
      pullRequests: collection.totalPullRequestContributions,
      issues: collection.totalIssueContributions,
      reviews: collection.totalPullRequestReviewContributions,
      days: collection.contributionCalendar.weeks.flatMap(week => week.contributionDays)
        .map(day => ({ date: day.date, count: day.contributionCount })),
    },
    publicProfile: {
      // Counts all public owned repositories, including forks and the profile repo.
      repositories: uniqueRepositories.length,
      followers: user.followers.totalCount,
      // Stars also include archived originals, but exclude forks and this profile repo.
      stars: originals.reduce((sum, repository) => sum + count(repository.stargazerCount, 'GitHub stars'), 0),
    },
    code: {
      repositories: codeRepositoryCount,
      languages: [...languageBytes].map(([name, bytes]) => ({ name, bytes })),
    },
  });
}

export function aggregateMonths(days, startDate, endDate) {
  validDate(startDate, 'startDate');
  validDate(endDate, 'endDate');
  if (startDate > endDate) throw new Error('Activity window ends before it starts');
  const monthCounts = new Map();
  for (const day of days) {
    if (day.date >= startDate && day.date <= endDate) {
      const month = day.date.slice(0, 7);
      monthCounts.set(month, (monthCounts.get(month) ?? 0) + day.count);
    }
  }
  const months = [];
  const endMonth = endDate.slice(0, 7);
  for (let date = new Date(`${startDate.slice(0, 7)}-01T00:00:00.000Z`); isoDate(date).slice(0, 7) <= endMonth;
    date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))) {
    const month = isoDate(date).slice(0, 7);
    const finalDate = isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
    months.push({
      month,
      label: date.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }),
      year: String(date.getUTCFullYear()),
      count: monthCounts.get(month) ?? 0,
      partial: `${month}-01` < startDate || finalDate > endDate,
    });
  }
  return months;
}

const formatNumber = value => value.toLocaleString('en-US');
const shortLabel = (value, maximum = 24) => [...value].length > maximum ? [...value].slice(0, maximum - 1).join('') + '…' : value;
const dateLabel = value => dateValue(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const updatedLabel = snapshot => `Updated ${snapshot.generatedAt.slice(0, 10)} ${snapshot.generatedAt.slice(11, 16)} UTC`;

function text(x, y, value, options = {}) {
  const { size = 15, weight = 400, fill = 'text', anchor = 'start', ...attributes } = options;
  return `<text x="${x}" y="${y}" class="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}"${Object.entries(attributes).map(([key, val]) => ` ${key}="${escapeXml(val)}"`).join('')}>${escapeXml(value)}</text>`;
}

function svg(snapshot, theme, height, title, description, content, width = 960) {
  const t = THEMES[theme];
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">${escapeXml(description)}</desc>
  <style>text{font-family:Segoe UI,Arial,sans-serif}.text{fill:${t.text}}.muted{fill:${t.muted}}.blue{fill:${t.blue}}.teal{fill:${t.teal}}.coral{fill:${t.coral}}</style>
  <rect width="${width}" height="${height}" rx="16" fill="${t.canvas}"/>
  <rect x="12" y="12" width="${width - 24}" height="${height - 24}" rx="16" fill="${t.paper}" stroke="${t.stroke}"/>
  ${content}
  ${text(32, height - 28, updatedLabel(snapshot), { size: 12, fill: 'muted' })}
</svg>
`;
}

function niceMaximum(value) {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const ceiling = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 4 ? 4 : fraction <= 5 ? 5 : fraction <= 8 ? 8 : 10) * magnitude;
  return Math.ceil(ceiling / 4) * 4;
}

function activitySvg(snapshot, theme) {
  const t = THEMES[theme];
  const months = aggregateMonths(snapshot.activity.days, snapshot.window.startDate, snapshot.window.endDate);
  const activeDays = snapshot.activity.days.filter(day => day.count > 0).length;
  const maximum = niceMaximum(Math.max(0, ...months.map(month => month.count)));
  const left = 86, right = 920, top = 126, bottom = 286;
  const width = (right - left) / months.length;
  let content = text(32, 48, 'A year in motion', { size: 26, weight: 650 })
    + text(32, 73, `${dateLabel(snapshot.window.startDate)} — ${dateLabel(snapshot.window.endDate)} · UTC`, { size: 14, fill: 'muted' })
    + text(920, 49, formatNumber(snapshot.activity.totalContributions), { size: 29, weight: 650, fill: 'blue', anchor: 'end' })
    + text(920, 72, `visible contributions · ${formatNumber(activeDays)} active days`, { size: 13, fill: 'muted', anchor: 'end' });
  for (let index = 0; index <= 4; index++) {
    const y = bottom - (bottom - top) * index / 4;
    content += `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="${t.stroke}"/>`
      + text(left - 12, y + 4, formatNumber(maximum * index / 4), { size: 12, fill: 'muted', anchor: 'end' });
  }
  months.forEach((month, index) => {
    const x = left + width * index + width * .19;
    const barWidth = width * .62;
    const height = month.count / maximum * (bottom - top);
    const color = index === months.length - 1 ? t.teal : t.blue;
    if (height > 0) {
      content += `<rect x="${x.toFixed(2)}" y="${(bottom - height).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${height.toFixed(2)}" rx="4" fill="${color}"><title>${escapeXml(`${month.label} ${month.year}${month.partial ? ' (partial)' : ''}: ${formatNumber(month.count)} contributions`)}</title></rect>`;
    } else {
      content += `<line x1="${x.toFixed(2)}" x2="${(x + barWidth).toFixed(2)}" y1="${bottom}" y2="${bottom}" stroke="${t.stroke}" stroke-width="3"><title>${escapeXml(`${month.label} ${month.year}: 0 contributions`)}</title></line>`;
    }
    content += text(left + width * (index + .5), 306, month.label + (month.partial ? '*' : ''), { size: 13, fill: 'muted', anchor: 'middle' });
    if (index === 0 || month.label === 'Jan' || index === months.length - 1) {
      content += text(left + width * (index + .5), 324, month.year, { size: 11, fill: 'muted', anchor: 'middle' });
    }
  });
  if (!snapshot.activity.totalContributions) content += text(503, 213, 'No visible contributions in this period', { size: 16, fill: 'muted', anchor: 'middle' });
  content += text(920, 354, '*Partial months · GitHub contribution calendar', { size: 12, fill: 'muted', anchor: 'end' });
  return svg(snapshot, theme, 382, `${snapshot.username}: visible GitHub activity`,
    `Monthly contributions from ${snapshot.window.startDate} through ${snapshot.window.endDate}. ${snapshot.activity.totalContributions} visible contributions across ${activeDays} active days. ${months.map(month => `${month.month}: ${month.count}${month.partial ? ', partial month' : ''}`).join('; ')}.`, content);
}

export function languageShares(languages) {
  const sorted = [...languages].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name, 'en'));
  const total = sorted.reduce((sum, language) => sum + language.bytes, 0);
  const visible = sorted.slice(0, 6);
  const other = sorted.slice(6).reduce((sum, language) => sum + language.bytes, 0);
  if (other) visible.push({ name: 'Other', bytes: other });
  return visible.map(language => ({ ...language, percentage: total ? language.bytes / total * 100 : 0 }));
}

function languagesSvg(snapshot, theme) {
  const t = THEMES[theme];
  const languages = languageShares(snapshot.code.languages);
  let content = text(32, 48, 'The code palette', { size: 26, weight: 650 })
    + text(32, 73, 'Language distribution across public, original repositories', { size: 14, fill: 'muted' })
    + text(920, 48, `${formatNumber(snapshot.code.repositories)} repos`, { size: 13, weight: 600, fill: 'muted', anchor: 'end' });
  if (languages.length) {
    let position = 32;
    content += `<defs><clipPath id="palette-clip"><rect x="32" y="98" width="896" height="12" rx="6"/></clipPath></defs><g clip-path="url(#palette-clip)">`;
    languages.forEach((language, index) => {
      const width = language.percentage / 100 * 896;
      content += `<rect x="${position.toFixed(3)}" y="98" width="${width.toFixed(3)}" height="12" fill="${t.palette[index]}"/>`;
      position += width;
    });
    content += '</g>';
    languages.forEach((language, index) => {
      const y = 140 + index * 27;
      const color = t.palette[index];
      content += `<circle cx="38" cy="${y - 5}" r="4" fill="${color}"/>`
        + text(52, y, shortLabel(language.name), { size: 15, weight: 550 })
        + `<rect x="245" y="${y - 12}" width="590" height="9" rx="4.5" fill="${t.canvas}"/>`
        + `<rect x="245" y="${y - 12}" width="${(language.percentage / 100 * 590).toFixed(2)}" height="9" rx="4.5" fill="${color}"><title>${escapeXml(`${language.name}: ${language.percentage.toFixed(1)}% of code bytes`)}</title></rect>`
        + text(920, y, `${language.percentage.toFixed(1)}%`, { size: 15, weight: 550, anchor: 'end' });
    });
  } else {
    content += text(480, 194, 'No language data in eligible public repositories yet', { size: 17, fill: 'muted', anchor: 'middle' });
  }
  content += text(920, 348, 'Share of code bytes · forks, archived repos & profile repo excluded', { size: 12, fill: 'muted', anchor: 'end' });
  return svg(snapshot, theme, 376, `${snapshot.username}: public repository languages`,
    `GitHub language byte distribution across ${snapshot.code.repositories} public owned repositories, excluding forks, archived repositories and the profile repository. Percentages describe code bytes, not proficiency. ${languages.map(language => `${language.name}: ${language.percentage.toFixed(1)} percent`).join('; ') || 'No language data'}.`, content);
}

function snapshotSvg(snapshot, theme) {
  const t = THEMES[theme];
  const metrics = [
    { label: 'Public repositories', value: snapshot.publicProfile.repositories, note: 'Owned · including forks' },
    { label: 'Followers', value: snapshot.publicProfile.followers, note: 'People following this profile' },
    { label: 'Repository stars', value: snapshot.publicProfile.stars, note: 'Owned originals · excluding profile' },
  ];
  const types = [
    { label: 'Commits', value: snapshot.activity.commits, color: t.blue },
    { label: 'Pull requests', value: snapshot.activity.pullRequests, color: t.teal },
    { label: 'Issues opened', value: snapshot.activity.issues, color: t.coral },
    { label: 'PR reviews', value: snapshot.activity.reviews, color: t.palette[3] },
  ];
  const maximum = Math.max(1, ...types.map(type => type.value));
  let content = text(32, 48, 'GitHub, at a glance', { size: 26, weight: 650 })
    + text(32, 73, 'A public profile snapshot & a year of visible contribution types', { size: 14, fill: 'muted' });
  metrics.forEach((metric, index) => {
    const x = 32 + index * 305;
    content += `<rect x="${x}" y="94" width="286" height="90" rx="10" fill="${t.canvas}"/>`
      + text(x + 16, 116, metric.label, { size: 11, weight: 600, fill: 'muted' })
      + text(x + 16, 148, formatNumber(metric.value), { size: 29, weight: 650, fill: index === 1 ? 'teal' : 'blue' })
      + text(x + 16, 171, metric.note, { size: 11, fill: 'muted' });
  });
  types.forEach((type, index) => {
    const y = 222 + index * 30;
    content += text(32, y, type.label, { size: 15 })
      + `<rect x="179" y="${y - 12}" width="650" height="11" rx="5.5" fill="${t.canvas}"/>`
      + `<rect x="179" y="${y - 12}" width="${(type.value / maximum * 650).toFixed(2)}" height="11" rx="5.5" fill="${type.color}"/>`
      + text(920, y, formatNumber(type.value), { size: 15, weight: 600, anchor: 'end' });
  });
  content += text(920, 355, 'Contribution types use the activity window above', { size: 12, fill: 'muted', anchor: 'end' });
  return svg(snapshot, theme, 383, `${snapshot.username}: GitHub profile snapshot`,
    `${snapshot.publicProfile.repositories} public owned repositories including forks; ${snapshot.publicProfile.followers} followers; ${snapshot.publicProfile.stars} stars on public owned nonfork repositories excluding the profile repository. From ${snapshot.window.startDate} to ${snapshot.window.endDate}: ${types.map(type => `${type.value} ${type.label.toLowerCase()}`).join(', ')}.`, content);
}

function mobileActivitySvg(snapshot, theme) {
  const t = THEMES[theme];
  const months = aggregateMonths(snapshot.activity.days, snapshot.window.startDate, snapshot.window.endDate);
  const activeDays = snapshot.activity.days.filter(day => day.count > 0).length;
  const maximum = niceMaximum(Math.max(0, ...months.map(month => month.count)));
  const left = 64, right = 456, top = 158, bottom = 290;
  const width = (right - left) / months.length;
  let content = text(24, 45, 'A year in motion', { size: 24, weight: 650 })
    + text(24, 69, `${dateLabel(snapshot.window.startDate)} — ${dateLabel(snapshot.window.endDate)} · UTC`, { size: 13, fill: 'muted' })
    + text(24, 112, formatNumber(snapshot.activity.totalContributions), { size: 30, weight: 650, fill: 'blue' })
    + text(24, 132, 'Visible contributions', { size: 13, fill: 'muted' })
    + text(456, 112, formatNumber(activeDays), { size: 25, weight: 650, fill: 'teal', anchor: 'end' })
    + text(456, 132, 'Active days', { size: 13, fill: 'muted', anchor: 'end' });
  for (let index = 0; index <= 4; index++) {
    const y = bottom - (bottom - top) * index / 4;
    content += `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="${t.stroke}"/>`
      + text(left - 12, y + 4, formatNumber(maximum * index / 4), { size: 14, fill: 'muted', anchor: 'end' });
  }
  months.forEach((month, index) => {
    const x = left + width * index + width * .18;
    const barWidth = width * .64;
    const height = month.count / maximum * (bottom - top);
    const color = index === months.length - 1 ? t.teal : t.blue;
    if (height > 0) {
      content += `<rect x="${x.toFixed(2)}" y="${(bottom - height).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${height.toFixed(2)}" rx="3" fill="${color}"><title>${escapeXml(`${month.label} ${month.year}${month.partial ? ' (partial)' : ''}: ${formatNumber(month.count)} contributions`)}</title></rect>`;
    } else {
      content += `<line x1="${x.toFixed(2)}" x2="${(x + barWidth).toFixed(2)}" y1="${bottom}" y2="${bottom}" stroke="${t.stroke}" stroke-width="3"/>`;
    }
    // The asterisk sits on the year line, leaving 13 month labels readable at 480px.
    content += text(left + width * (index + .5), 311, month.label, { size: 14, fill: 'muted', anchor: 'middle' });
    if (index === 0 || month.label === 'Jan' || index === months.length - 1) {
      content += text(left + width * (index + .5), 331, month.year.slice(2) + (month.partial ? '*' : ''), { size: 14, fill: 'muted', anchor: 'middle' });
    }
  });
  if (!snapshot.activity.totalContributions) {
    content += text(260, 215, 'No visible contributions', { size: 16, fill: 'muted', anchor: 'middle' })
      + text(260, 237, 'in this period', { size: 16, fill: 'muted', anchor: 'middle' });
  }
  content += text(24, 358, '*Partial months · GitHub contribution calendar', { size: 12, fill: 'muted' });
  return svg(snapshot, theme, 404, `${snapshot.username}: visible GitHub activity`,
    `Monthly contributions from ${snapshot.window.startDate} through ${snapshot.window.endDate}. ${snapshot.activity.totalContributions} visible contributions across ${activeDays} active days. ${months.map(month => `${month.month}: ${month.count}${month.partial ? ', partial month' : ''}`).join('; ')}.`, content, 480);
}

function mobileLanguagesSvg(snapshot, theme) {
  const t = THEMES[theme];
  const languages = languageShares(snapshot.code.languages);
  let content = text(24, 45, 'The code palette', { size: 24, weight: 650 })
    + text(24, 69, 'Language distribution across public,', { size: 13, fill: 'muted' })
    + text(24, 88, `original repositories · ${formatNumber(snapshot.code.repositories)} repos`, { size: 13, fill: 'muted' });
  if (languages.length) {
    let position = 24;
    content += `<defs><clipPath id="palette-clip"><rect x="24" y="108" width="432" height="10" rx="5"/></clipPath></defs><g clip-path="url(#palette-clip)">`;
    languages.forEach((language, index) => {
      const width = language.percentage / 100 * 432;
      content += `<rect x="${position.toFixed(3)}" y="108" width="${width.toFixed(3)}" height="10" fill="${t.palette[index]}"/>`;
      position += width;
    });
    content += '</g>';
    languages.forEach((language, index) => {
      const y = 150 + index * 30;
      const color = t.palette[index];
      content += text(24, y, shortLabel(language.name, 30), { size: 14, weight: 550 })
        + text(456, y, `${language.percentage.toFixed(1)}%`, { size: 14, weight: 550, anchor: 'end' })
        + `<rect x="24" y="${y + 7}" width="432" height="6" rx="3" fill="${t.canvas}"/>`
        + `<rect x="24" y="${y + 7}" width="${(language.percentage / 100 * 432).toFixed(2)}" height="6" rx="3" fill="${color}"><title>${escapeXml(`${language.name}: ${language.percentage.toFixed(1)}% of code bytes`)}</title></rect>`;
    });
  } else {
    content += text(240, 210, 'No language data in eligible', { size: 17, fill: 'muted', anchor: 'middle' })
      + text(240, 234, 'public repositories yet', { size: 17, fill: 'muted', anchor: 'middle' });
  }
  content += text(24, 372, 'Share of code bytes', { size: 13, fill: 'muted' })
    + text(24, 391, 'Forks, archived repos & profile repo excluded', { size: 12, fill: 'muted' });
  return svg(snapshot, theme, 438, `${snapshot.username}: public repository languages`,
    `GitHub language byte distribution across ${snapshot.code.repositories} public owned repositories, excluding forks, archived repositories and the profile repository. Percentages describe code bytes, not proficiency. ${languages.map(language => `${language.name}: ${language.percentage.toFixed(1)} percent`).join('; ') || 'No language data'}.`, content, 480);
}

function mobileSnapshotSvg(snapshot, theme) {
  const t = THEMES[theme];
  const metrics = [
    { label: 'Public repositories', value: snapshot.publicProfile.repositories, note: 'Owned · including forks' },
    { label: 'Followers', value: snapshot.publicProfile.followers, note: 'People following this profile' },
    { label: 'Repository stars', value: snapshot.publicProfile.stars, note: 'Owned originals · excluding profile' },
  ];
  const types = [
    { label: 'Commits', value: snapshot.activity.commits, color: t.blue },
    { label: 'Pull requests', value: snapshot.activity.pullRequests, color: t.teal },
    { label: 'Issues opened', value: snapshot.activity.issues, color: t.coral },
    { label: 'PR reviews', value: snapshot.activity.reviews, color: t.palette[3] },
  ];
  const maximum = Math.max(1, ...types.map(type => type.value));
  let content = text(24, 45, 'GitHub, at a glance', { size: 24, weight: 650 })
    + text(24, 69, 'A public snapshot & visible contribution types', { size: 13, fill: 'muted' });
  metrics.forEach((metric, index) => {
    const y = 94 + index * 71;
    content += `<rect x="24" y="${y}" width="432" height="64" rx="10" fill="${t.canvas}"/>`
      + text(40, y + 24, metric.label, { size: 14, weight: 600 })
      + text(436, y + 40, formatNumber(metric.value), { size: 28, weight: 650, fill: index === 1 ? 'teal' : 'blue', anchor: 'end' })
      + text(40, y + 46, metric.note, { size: 12, fill: 'muted' });
  });
  types.forEach((type, index) => {
    const y = 337 + index * 36;
    content += text(24, y, type.label, { size: 14 })
      + text(456, y, formatNumber(type.value), { size: 14, weight: 600, anchor: 'end' })
      + `<rect x="24" y="${y + 8}" width="432" height="8" rx="4" fill="${t.canvas}"/>`
      + `<rect x="24" y="${y + 8}" width="${(type.value / maximum * 432).toFixed(2)}" height="8" rx="4" fill="${type.color}"/>`;
  });
  content += text(24, 487, 'Contribution types follow the activity window.', { size: 12, fill: 'muted' });
  return svg(snapshot, theme, 548, `${snapshot.username}: GitHub profile snapshot`,
    `${snapshot.publicProfile.repositories} public owned repositories including forks; ${snapshot.publicProfile.followers} followers; ${snapshot.publicProfile.stars} stars on public owned nonfork repositories excluding the profile repository. From ${snapshot.window.startDate} to ${snapshot.window.endDate}: ${types.map(type => `${type.value} ${type.label.toLowerCase()}`).join(', ')}.`, content, 480);
}

export function renderProfile(input) {
  const snapshot = normalizeSnapshot(input);
  const assets = {};
  for (const theme of Object.keys(THEMES)) {
    assets[`activity-${theme}.svg`] = activitySvg(snapshot, theme);
    assets[`languages-${theme}.svg`] = languagesSvg(snapshot, theme);
    assets[`snapshot-${theme}.svg`] = snapshotSvg(snapshot, theme);
    assets[`activity-${theme}-mobile.svg`] = mobileActivitySvg(snapshot, theme);
    assets[`languages-${theme}-mobile.svg`] = mobileLanguagesSvg(snapshot, theme);
    assets[`snapshot-${theme}-mobile.svg`] = mobileSnapshotSvg(snapshot, theme);
  }
  return assets;
}

export async function writeAssets(snapshot, output) {
  await mkdir(output, { recursive: true });
  for (const [name, markup] of Object.entries(renderProfile(snapshot))) await writeFile(resolve(output, name), markup, 'utf8');
}

export function parseArguments(args) {
  const options = { username: 'HYHBalci', output: 'assets' };
  const allowed = new Set(['username', 'output', 'input', 'save-data']);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help' || args[index] === '-h') return { help: true };
    const key = args[index].startsWith('--') ? args[index].slice(2) : '';
    if (!allowed.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument: ${args[index]}`);
    options[key] = args[++index];
  }
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    process.stdout.write('Usage: node scripts/generate-profile.mjs [--username LOGIN] [--output assets] [--input snapshot.json] [--save-data .local/profile-data.json]\nRequires GH_TOKEN or GITHUB_TOKEN for live collection. Node 20+, no dependencies.\n');
    return;
  }
  const snapshot = options.input
    ? normalizeSnapshot(JSON.parse(await readFile(resolve(options.input), 'utf8')))
    : await collectProfile({ username: options.username, token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN });
  if (snapshot.username.toLowerCase() !== options.username.toLowerCase()) throw new Error('Snapshot username does not match --username');
  await writeAssets(snapshot, resolve(options.output));
  if (options['save-data']) {
    const file = resolve(options['save-data']);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  }
  process.stdout.write(`Generated 12 SVG charts for ${snapshot.username}: ${formatNumber(snapshot.activity.totalContributions)} visible contributions, ${snapshot.publicProfile.repositories} public owned repositories.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
