const { zohoClient } = require('../../common/config/axios');
const logger = require('../../common/logging/logger');
const { getModuleDefinitions, getModuleDefinition } = require('./module-definition.service');

const USER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache
let cachedUsers = null;
let lastUsersFetch = 0;

function normalizeString(val) {
  return String(val || '').trim().toLowerCase();
}

async function fetchZohoUsers(options = {}) {
  const now = Date.now();
  if (cachedUsers && (now - lastUsersFetch < USER_CACHE_TTL_MS) && !options.forceRefresh) {
    return cachedUsers;
  }

  try {
    const response = await zohoClient.get('/crm/v8/users', {
      ...(options.signal ? { signal: options.signal } : {}),
      params: { type: 'AllUsers' },
    });

    const rawUsers = Array.isArray(response.data?.users)
      ? response.data.users
      : Array.isArray(response.data?.data)
        ? response.data.data
        : [];

    cachedUsers = rawUsers.map((u) => ({
      id: String(u.id || u.ID || ''),
      name: u.full_name || `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.name || 'Unknown User',
      first_name: u.first_name || '',
      last_name: u.last_name || '',
      email: u.email || '',
      role: u.role?.name || u.role || '',
      status: u.status || 'active',
    })).filter((u) => u.id);

    lastUsersFetch = now;
    logger.info('CRM Metadata Service', {
      event: 'users_fetched',
      count: cachedUsers.length,
    });

    return cachedUsers;
  } catch (error) {
    logger.warn('CRM Metadata Service', {
      event: 'fetch_users_failed',
      error: error.message,
    });

    // If cache exists, return stale cache; otherwise return empty array
    if (cachedUsers) return cachedUsers;
    return [];
  }
}

async function resolveUser(nameOrId, options = {}) {
  if (!nameOrId) return null;
  const inputStr = String(nameOrId).trim();
  const normalizedInput = normalizeString(inputStr);

  const users = await fetchZohoUsers(options);

  // 1. Direct ID match
  const exactIdMatch = users.find((u) => u.id === inputStr);
  if (exactIdMatch) {
    return { id: exactIdMatch.id, name: exactIdMatch.name, user_name: exactIdMatch.name };
  }

  // 2. Exact full name match
  const exactNameMatch = users.find((u) => normalizeString(u.name) === normalizedInput);
  if (exactNameMatch) {
    return { id: exactNameMatch.id, name: exactNameMatch.name, user_name: exactNameMatch.name };
  }

  // 3. First name match
  const firstNameMatch = users.find((u) => normalizeString(u.first_name) === normalizedInput);
  if (firstNameMatch) {
    return { id: firstNameMatch.id, name: firstNameMatch.name, user_name: firstNameMatch.name };
  }

  // 4. Substring name match
  const partialNameMatch = users.find((u) => normalizeString(u.name).includes(normalizedInput));
  if (partialNameMatch) {
    return { id: partialNameMatch.id, name: partialNameMatch.name, user_name: partialNameMatch.name };
  }

  // Fallback if not found in fetched users (e.g. offline/mock or not in users list)
  return { id: inputStr, name: inputStr, user_name: inputStr };
}

function resolveModuleApiName(moduleLabelOrKey) {
  if (!moduleLabelOrKey) return null;
  const input = normalizeString(moduleLabelOrKey);

  const definitions = getModuleDefinitions();
  const found = definitions.find(
    (d) => normalizeString(d.key) === input || normalizeString(d.label) === input || normalizeString(d.endpoint) === input
  );

  return found ? found.endpoint : moduleLabelOrKey;
}

function resolveModuleLabel(moduleEndpointOrKey) {
  if (!moduleEndpointOrKey) return null;
  const input = normalizeString(moduleEndpointOrKey);

  const definitions = getModuleDefinitions();
  const found = definitions.find(
    (d) => normalizeString(d.key) === input || normalizeString(d.label) === input || normalizeString(d.endpoint) === input
  );

  return found ? found.label : moduleEndpointOrKey;
}

let cachedOrg = null;
let lastOrgFetch = 0;

async function fetchOrgMetadata(options = {}) {
  const now = Date.now();
  if (cachedOrg && (now - lastOrgFetch < USER_CACHE_TTL_MS) && !options.forceRefresh) {
    return cachedOrg;
  }

  try {
    const response = await zohoClient.get('/crm/v8/org', {
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const orgData = Array.isArray(response.data?.org) ? response.data.org[0] : (response.data?.org || response.data?.data?.[0] || {});
    cachedOrg = {
      currency_symbol: orgData.currency_symbol || '\u20B9',
      currency_locale: orgData.currency_locale || 'en_IN',
      currency: orgData.currency || orgData.iso_code || 'INR',
      name: orgData.company_name || 'F-Grade',
    };
    lastOrgFetch = now;
    return cachedOrg;
  } catch (error) {
    logger.warn('CRM Metadata Service', {
      event: 'fetch_org_failed',
      error: error.message,
    });
    return cachedOrg || { currency_symbol: '\u20B9', currency_locale: 'en_IN', currency: 'INR' };
  }
}

module.exports = {
  fetchZohoUsers,
  resolveUser,
  resolveModuleApiName,
  resolveModuleLabel,
  fetchOrgMetadata,
};
