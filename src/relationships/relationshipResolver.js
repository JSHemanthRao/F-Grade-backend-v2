const { createAppError } = require('../utils/errors');

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function labelOf(field) {
  return field?.display_label || field?.field_label || field?.label || field?.api_name || '';
}

function targetModuleOf(field) {
  const lookup = field?.lookup || field?.lookup_module || field?.associated_module || field?.module;
  if (lookup && typeof lookup === 'object' && lookup.module) return Array.isArray(lookup.module) ? lookup.module : [lookup.module];
  if (Array.isArray(lookup)) return lookup;
  if (lookup && typeof lookup === 'object') return [lookup];
  return lookup ? [{ api_name: lookup }] : [];
}

function isLookup(field) {
  return ['lookup', 'multi_select_lookup'].includes(String(field?.data_type || '').toLowerCase())
    || Boolean(field?.multi_module_lookup || field?.multiselectlookup);
}

function moduleNames(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  return [value.api_name, value.module_name, value.plural_label, value.singular_label, value.name, value.label].filter(Boolean);
}

function tokens(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function findField(fields, request) {
  const wanted = normalize(request);
  if (!wanted) return null;
  return fields.find((field) => [field?.api_name, labelOf(field), field?.name]
    .filter(Boolean)
    .some((value) => normalize(value) === wanted));
}

function relationshipFields(metadata) {
  return metadata.filter(isLookup);
}

/**
 * Resolves a user-facing field phrase against the live metadata graph. The
 * output remains a COQL-compatible dotted path, while path_segments preserves
 * the metadata-derived relationship structure for validation and diagnostics.
 */
async function resolveRequestedFields({ module, fieldLabels = [], metadata = [], getFieldMetadata, maxDepth = 3 }) {
  const fields = [];
  const relationships = [];
  const resolved = [];

  for (const rawLabel of fieldLabels) {
    const label = String(rawLabel || '').replace(/^the\s+/i, '').trim();
    if (!label) continue;
    const direct = findField(metadata, label);
    const resolution = direct
      ? await resolveDirectField(module, direct, getFieldMetadata)
      : await resolveRelationshipPath({ module, label, metadata, getFieldMetadata, maxDepth });

    fields.push(resolution.field);
    if (resolution.relationship) relationships.push(resolution.relationship);
    resolved.push({ label, ...resolution });
  }

  return {
    fields: [...new Set(fields)],
    relationships: uniqueRelationships(relationships),
    resolved
  };
}

async function resolveDirectField(module, field, getFieldMetadata) {
  if (!isLookup(field) || typeof getFieldMetadata !== 'function') {
    return { field: field.api_name, field_metadata: field, relationship: null };
  }
  const target = targetModuleOf(field)[0];
  const targetModule = moduleNames(target)[0];
  if (!targetModule) return { field: field.api_name, field_metadata: field, relationship: null };
  const targetMetadata = await getFieldMetadata(targetModule);
  const targetField = findNameField(targetMetadata.metadata || []);
  if (!targetField) return { field: field.api_name, field_metadata: field, relationship: null };
  return relationshipResolution(module, [{ field: field.api_name, target_module: targetModule }], targetField, targetMetadata.metadata || []);
}

async function resolveRelationshipPath({ module, label, metadata, getFieldMetadata, maxDepth }) {
  if (typeof getFieldMetadata !== 'function') {
    throw unresolvedRelationship(module, label, metadata);
  }

  const result = await traverseRelationshipGraph({
    rootModule: module,
    currentModule: module,
    currentMetadata: metadata,
    label,
    path: [],
    getFieldMetadata,
    maxDepth,
    visited: new Set([module])
  });
  if (!result) throw unresolvedRelationship(module, label, metadata);
  return result;
}

async function traverseRelationshipGraph({ rootModule, currentModule, currentMetadata, label, path, getFieldMetadata, maxDepth, visited }) {
  const direct = findField(currentMetadata, label);
  if (direct && path.length > 0) return relationshipResolution(rootModule, path, direct, currentMetadata);
  if (path.length >= maxDepth) return null;

  const words = tokens(label);
  const candidates = relationshipFields(currentMetadata)
    .map((field) => ({ field, score: relationshipScore(field, words) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  for (const { field } of candidates) {
    const target = targetModuleOf(field)[0];
    const targetModule = moduleNames(target)[0];
    if (!targetModule) continue;
    const targetMetadataResult = await getFieldMetadata(targetModule);
    const targetMetadata = targetMetadataResult.metadata || [];
    const remainingLabel = removeRelationshipTerms(label, field);
    const nextPath = [...path, { field: field.api_name, target_module: targetModule }];

    const targetField = findField(targetMetadata, remainingLabel)
      || (isNamePhrase(remainingLabel) ? findNameField(targetMetadata) : null)
      || findField(targetMetadata, label.replace(new RegExp(`^${escapeRegExp(labelOf(field))}\\s*`, 'i'), '').trim());
    if (targetField) return relationshipResolution(rootModule, nextPath, targetField, targetMetadata);

    const nextVisit = `${targetModule}:${normalize(remainingLabel)}`;
    if (!visited.has(nextVisit) && remainingLabel) {
      const nested = await traverseRelationshipGraph({
        rootModule,
        currentModule: targetModule,
        currentMetadata: targetMetadata,
        label: remainingLabel,
        path: nextPath,
        getFieldMetadata,
        maxDepth,
        visited: new Set([...visited, nextVisit])
      });
      if (nested) return nested;
    }
  }
  return null;
}

function relationshipResolution(sourceModule, pathSegments, targetField, targetMetadata) {
  const path = [...pathSegments.map((segment) => segment.field), targetField.api_name].join('.');
  const first = pathSegments[0];
  const last = pathSegments[pathSegments.length - 1];
  return {
    field: path,
    field_metadata: targetField,
    relationship: {
      source_module: sourceModule,
      source_field: first.field,
      target_module: last.target_module,
      target_fields: [targetField.api_name],
      target_field: targetField.api_name,
      path_segments: pathSegments.map((segment) => ({ ...segment })),
      path
    },
    target_metadata: targetMetadata
  };
}

function relationshipScore(field, words) {
  const relationWords = new Set([field.api_name, labelOf(field), ...targetModuleOf(field).flatMap(moduleNames)].flatMap(tokens));
  return words.reduce((total, word) => total + (relationWords.has(word) ? 1 : 0), 0)
    + (relationWords.has(words[0]) ? 2 : 0);
}

function removeRelationshipTerms(label, field) {
  const phrase = tokens(label);
  const aliases = [field.api_name, labelOf(field)]
    .map(tokens)
    .filter((alias) => alias.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const alias of aliases) {
    if (alias.every((word, index) => phrase[index] === word)) {
      return phrase.slice(alias.length).join(' ');
    }
  }

  // A natural-language relationship reference often uses just the leading
  // noun ("account industry") rather than its full lookup label
  // ("account name"). Consume only that noun; removing every matching term
  // would incorrectly discard a later terminal field such as "name".
  const relationTerms = new Set([field.api_name, labelOf(field), ...targetModuleOf(field).flatMap(moduleNames)].flatMap(tokens));
  return relationTerms.has(phrase[0]) ? phrase.slice(1).join(' ') : phrase.join(' ');
}

function findNameField(metadata) {
  return metadata.find((field) => field.name_field || field.is_name_field)
    || metadata.find((field) => /(?:^|_)(?:name|title|subject)(?:_|$)/i.test(String(field.api_name || '')));
}

function isNamePhrase(value) {
  return /^(?:name|full\s+name|display\s+name)$/i.test(String(value || '').trim());
}

function uniqueRelationships(relationships) {
  const seen = new Set();
  return relationships.filter((relationship) => {
    const key = relationship.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unresolvedRelationship(module, field, metadata) {
  return createAppError('RELATIONSHIP_NOT_RESOLVED', `CRM relationship field '${field}' could not be resolved for module '${module}'.`, 400, {
    module,
    field,
    candidates: relationshipFields(metadata).map((candidate) => ({ api_name: candidate.api_name, field_label: labelOf(candidate) }))
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { resolveRequestedFields, isLookup, targetModuleOf, relationshipFields };
