// Provider telemetry only. Never derive a context meter from cumulative billing totals.
/** @typedef {{usedTokens:number, contextWindow:number, usedPercent:number, updatedAt:number, source:string, estimated?:boolean, model?:string}} ContextUsage */
/** @typedef {{id:string, label:string, usedPercent?:number, resetsAt?:number, status?:string}} UsageWindow */
/** @typedef {{status:'loading'|'available'|'unavailable'|'error', windows:UsageWindow[], updatedAt?:number, source?:string, message?:string, plan?:string}} ProviderUsage */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1e12;
const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
const label = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : undefined;
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : undefined;
const seconds = value => typeof value === 'number' ? timestamp(value * 1000) : undefined;
const iso = value => typeof value === 'string' ? timestamp(Date.parse(value)) : undefined;

/** @returns {ContextUsage | undefined} */
export function normalizeStoredContext(value) {
  if (!record(value) || !count(value.usedTokens) || !count(value.contextWindow) || !value.contextWindow || !timestamp(value.updatedAt) || !label(value.source)) return undefined;
  return { usedTokens: value.usedTokens, contextWindow: value.contextWindow, usedPercent: value.usedTokens / value.contextWindow * 100,
    updatedAt: value.updatedAt, source: label(value.source), ...(value.estimated === true ? { estimated: true } : {}), ...(label(value.model) ? { model: label(value.model) } : {}) };
}
export function codexContextUsage(value, at = Date.now()) {
  return normalizeStoredContext({ usedTokens: value?.last?.totalTokens, contextWindow: value?.modelContextWindow, updatedAt: at, source: 'Codex thread token usage' });
}
export function claudeContextUsage(value, at = Date.now()) {
  return normalizeStoredContext({ usedTokens: value?.totalTokens ?? value?.total_tokens, contextWindow: value?.rawMaxTokens ?? value?.raw_max_tokens,
    updatedAt: at, source: 'Claude context summary', estimated: true, model: value?.model });
}
/** @returns {ProviderUsage} */
export function unavailableUsage(message = 'Usage has not been reported yet.', source) { return { status: 'unavailable', windows: [], message, ...(source ? { source } : {}) }; }
const durationLabel = (minutes, fallback) => count(minutes) && minutes > 0 ? minutes % 1440 === 0 ? `${minutes / 1440}-day` : minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute` : fallback;

/** Full reads replace the previous snapshot; sparse notifications preserve missing windows.
 * @returns {ProviderUsage} */
export function codexProviderUsage(value, at = Date.now(), previous = undefined) {
  const buckets = record(value?.rateLimitsByLimitId) ? Object.entries(value.rateLimitsByLimitId) : [];
  const fallback = value?.rateLimits;
  if (record(fallback) && !buckets.some(([id]) => id === (fallback.limitId || 'codex'))) buckets.unshift([fallback.limitId || 'codex', fallback]);
  const windows = previous ? [...previous.windows] : [];
  let plan = previous?.plan;
  for (const [bucketId, bucket] of buckets.slice(0, 20)) {
    if (!record(bucket)) continue;
    plan = label(bucket.planType) || plan;
    const prefix = bucketId === 'codex' ? '' : `${label(bucket.limitName) || label(bucketId) || 'Model'} · `;
    for (const key of ['primary', 'secondary']) {
      const entry = bucket[key]; if (!record(entry)) continue;
      const id = `${bucketId}:${key}`, old = windows.find(window => window.id === id);
      const usedPercent = percent(entry.usedPercent), resetsAt = seconds(entry.resetsAt);
      const window = { ...(old || {}), id, label: old && entry.windowDurationMins == null ? old.label : prefix + durationLabel(entry.windowDurationMins, key === 'primary' ? 'Primary limit' : 'Secondary limit'),
        ...(usedPercent !== undefined ? { usedPercent } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) };
      const index = windows.findIndex(window => window.id === id);
      if (index < 0) windows.push(window); else windows[index] = window;
    }
  }
  windows.sort((a, b) => Number(!a.id.startsWith('codex:')) - Number(!b.id.startsWith('codex:')));
  return { status: windows.length ? 'available' : 'unavailable', windows, updatedAt: at, source: 'Codex account limits', ...(plan ? { plan } : {}),
    ...(value?.ordinaryUsageAllowed === false ? { message: 'Codex reports that included usage is currently unavailable.' } : !windows.length ? { message: 'This Codex account did not report usage windows.' } : {}) };
}

/** @returns {ProviderUsage} */
export function claudeProviderUsage(value, at = Date.now()) {
  const limits = value?.rate_limits;
  if (value?.rate_limits_available === false || !record(limits)) return { ...unavailableUsage('Plan usage is unavailable for this Claude account or connection.', 'Claude account limits'), updatedAt: at };
  /** @type {UsageWindow[]} */
  const windows = [];
  const add = (id, name, entry) => {
    if (!record(entry)) return;
    const usedPercent = percent(entry.utilization), resetsAt = iso(entry.resets_at);
    windows.push({ id, label: name, ...(usedPercent !== undefined ? { usedPercent } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) });
  };
  for (const [id, name] of [['five_hour', '5-hour'], ['seven_day', '7-day'], ['seven_day_opus', 'Opus · 7-day'], ['seven_day_sonnet', 'Sonnet · 7-day'], ['seven_day_oauth_apps', 'Apps · 7-day']]) add(id, name, limits[id]);
  if (Array.isArray(limits.model_scoped)) for (const [index, row] of limits.model_scoped.slice(0, 20).entries()) add(`model:${index}`, `${label(row?.display_name) || 'Model'} · 7-day`, row);
  if (limits.extra_usage?.is_enabled === true) add('extra_usage', 'Extra usage', limits.extra_usage);
  return { status: windows.length ? 'available' : 'unavailable', windows, updatedAt: at, source: 'Claude account limits', ...(label(value?.subscription_type) ? { plan: label(value.subscription_type) } : {}),
    ...(!windows.length ? { message: 'Claude did not report any plan usage windows.' } : {}) };
}
