const fs = require('fs');
const path = require('path');

const spec = {
  swagger: '2.0',
  info: {
    title: 'F-Grade Zoho CRM API',
    version: '1.0.0',
    description: 'Read-only Zoho CRM API for Microsoft Copilot Studio.',
    license: {
      name: 'ISC',
      url: 'https://spdx.org/licenses/ISC.html',
    },
  },
  host: 'f-grade-backend.onrender.com',
  basePath: '/',
  schemes: ['https'],
  produces: ['application/json'],
  security: [],
  paths: {
    '/api/crm/count': {
      get: {
        operationId: 'countCRMRecords',
        tags: ['CRM'],
        summary: 'Count Zoho CRM records',
        description: "Use this operation whenever the user asks how many, count, total, number of records, or a filtered record count. Returns the complete matching CRM record count. Never use pagination for this operation.",
        parameters: [
          {
            name: 'module',
            in: 'query',
            required: true,
            type: 'string',
            description: 'Canonical or natural-language module name. Examples: Leads, Contacts, Accounts, Deals.',
          },
          {
            name: 'filter',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional Zoho CRM criteria string for filtered counts.',
          },
          {
            name: 'date_field',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional CRM date field API name to filter count by, such as Created_Time or Modified_Time.',
          },
          {
            name: 'from',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Date or ISO datetime representing the start of the inclusive date range.',
          },
          {
            name: 'to',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Date or ISO datetime representing the exclusive end of the date range.',
          },
        ],
        responses: {
          200: {
            description: 'Successful CRM count response',
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                module: { type: 'string' },
                count: { type: 'integer', format: 'int32' },
                executionTime: { type: 'string' },
                source: { type: 'string' },
              },
            },
          },
          400: {
            description: 'Validation error',
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                error: { type: 'string' },
              },
            },
          },
          401: {
            description: 'Authentication required or invalid OAuth token',
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                error: { type: 'string' },
              },
            },
          },
          500: {
            description: 'Server error or Zoho API error',
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
    },
    '/api/crm/query': {
      get: {
        operationId: 'queryCRMRecords',
        tags: ['CRM'],
        summary: 'Query Zoho CRM records',
        description: 'Use this operation when the user asks to view, list, show, retrieve, or inspect CRM records. The backend searches the complete matching CRM dataset internally and returns a display batch. Do not treat one returned batch as the complete dataset.',
        parameters: [
          {
            name: 'module',
            in: 'query',
            required: true,
            type: 'string',
            description: 'Canonical or natural-language module name. Examples: Leads, Contacts, Accounts, Deals.',
          },
          {
            name: 'page',
            in: 'query',
            required: false,
            type: 'integer',
            format: 'int32',
            minimum: 1,
            description: 'Optional page number for paginated requests.',
          },
          {
            name: 'per_page',
            in: 'query',
            required: false,
            type: 'integer',
            format: 'int32',
            minimum: 1,
            description: 'Optional records per page for paginated requests.',
          },
          {
            name: 'fields',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional comma-separated field API names to include in each record.',
          },
          {
            name: 'date_field',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional CRM date field API name to filter by, such as Created_Time or Modified_Time.',
          },
          {
            name: 'from',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Date or ISO datetime representing the start of the inclusive date range.',
          },
          {
            name: 'to',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Date or ISO datetime representing the exclusive end of the date range.',
          },
          {
            name: 'filter',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional Zoho CRM criteria string for server-side filtering.',
          },
          {
            name: 'ids',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional comma-separated list of CRM record ids to fetch.',
          },
        ],
        responses: {
          200: {
            description: 'Successful CRM response',
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                module: { type: 'string' },
                count: { type: 'integer', format: 'int32' },
                page: { type: 'integer', format: 'int32' },
                per_page: { type: 'integer', format: 'int32' },
                executionTime: { type: 'string' },
                source: { type: 'string' },
                data: {
                  type: 'array',
                  items: { type: 'object' },
                },
              },
            },
          },
          400: {
            description: 'Validation error',
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                error: { type: 'string' },
              },
            },
          },
          401: {
            description: 'Authentication required or invalid OAuth token',
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                error: { type: 'string' },
              },
            },
          },
          500: {
            description: 'Server error or Zoho API error',
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

const outPath = path.join(__dirname, 'crm.openapi.json');
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2), 'utf8');
console.log('Wrote', outPath);
