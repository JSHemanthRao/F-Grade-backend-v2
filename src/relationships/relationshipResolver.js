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
  return fields.find((field) => [field?.api_name, labelOf(field), field?.name].some((value) => normalize(value) === wanted));
}

function relationshipFields(metadata) {
  return metadata.filter(isLookup);
}

async function resolveRequestedFields({ module, fieldLabels = [], metadata = [], getFieldMetadata }) {
  const baseFields = [];
  const relationships = [];
  for (const rawLabel of fieldLabels) {
    const label = String(rawLabel || '').replace(/^the\s+/i, '').trim();
    const direct = findField(metadata, label);
    if (direct) {
      if (isLookup(direct) && typeof getFieldMetadata === 'function') {
        const target = targetModuleOf(direct)[0];
        const targetApiName = moduleNames(target)[0];
        const targetMetadata = await getFieldMetadata(targetApiName);
        const targetField = (targetMetadata.metadata || []).find((field) => field.name_field || field.is_name_field);
        if (targetField) {
          const path = `${direct.api_name}.${targetField.api_name}`;
          baseFields.push(path);
          relationships.push({ source_field: direct.api_name, target_module: targetApiName, target_fields: [targetField.api_name], path });
          continue;
        }
      }
      baseFields.push(direct.api_name);
      continue;
    }

    const words = label.split(/\s+/);
    const relationship = relationshipFields(metadata)
      .map((candidate) => {
        const relationWords = new Set([candidate.api_name, labelOf(candidate), ...targetModuleOf(candidate).flatMap(moduleNames)].flatMap(tokens));
        const score = words.reduce((total, word) => total + (relationWords.has(normalize(word)) ? 1 : 0), 0)
          + (relationWords.has(normalize(words[0])) ? 2 : 0);
        return { candidate, score };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)[0]?.candidate;
    if (!relationship || typeof getFieldMetadata !== 'function') {
      throw createAppError('RELATIONSHIP_NOT_RESOLVED', `CRM relationship field '${rawLabel}' could not be resolved for module '${module}'.`, 400, {
        module,
        field: rawLabel,
        candidates: relationshipFields(metadata).map((field) => ({ api_name: field.api_name, field_label: labelOf(field) }))
      });
    }

    const target = targetModuleOf(relationship)[0];
    const targetApiName = moduleNames(target)[0];
    const targetMetadata = await getFieldMetadata(targetApiName);
    const relationTokens = new Set([relationship.api_name, labelOf(relationship), ...targetModuleOf(relationship).flatMap(moduleNames)].flatMap(tokens));
    const targetLabel = words.filter((word) => !relationTokens.has(normalize(word))).join(' ');
    const targetFields = targetMetadata.metadata || [];
    const targetField = findField(targetFields, targetLabel)
      || (/(?:^|\s)(?:name|full\s+name|display\s+name)(?:\s|$)/i.test(targetLabel) ? targetFields.find((field) => field.name_field || field.is_name_field) : null)
      || findField(targetFields, label.replace(new RegExp(`^${labelOf(relationship)}\\s*`, 'i'), '').trim());
    if (!targetField) {
      throw createAppError('RELATIONSHIP_FIELD_NOT_RESOLVED', `CRM related field '${rawLabel}' could not be resolved from '${labelOf(relationship)}'.`, 400, { module, relationship_field: relationship.api_name, target_module: targetApiName, field: rawLabel });
    }
    const path = `${relationship.api_name}.${targetField.api_name}`;
    baseFields.push(path);
    relationships.push({ source_field: relationship.api_name, target_module: targetApiName, target_fields: [targetField.api_name], path });
  }
  return { fields: [...new Set(baseFields)], relationships };
}

module.exports = { resolveRequestedFields, isLookup, targetModuleOf };