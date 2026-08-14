const fs = require('fs');
const path = require('path');

const spec = {
  swagger: '2.0',
  info: {
    title: 'F-Grade Zoho CRM API',
    version: '1.0.0',
    description: 'Read-only Zoho CRM API for Microsoft Copilot Studio. Determine the user\'s requested record count, filters, date range, operation, and fields and pass them as structured inputs. Never default to retrieving the complete module.',
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
        description: "Use this operation whenever the user asks how many, count, total, number of records, or a filtered record count. Determine the user's filters and date range and pass them as structured inputs. Returns the complete matching CRM record count without retrieving records.",
        parameters: [
          {
            name: 'module',
            in: 'query',
            required: true,
            type: 'string',
            description: 'Canonical or natural-language module name. Examples: Leads, Contacts, Accounts, Deals.',
          },
          {
            name: 'operation',
            in: 'query',
            required: false,
            type: 'string',
            enum: ['count'],
            description: 'Use count for count questions such as "how many leads were created in July".',
          },
          {
            name: 'criteria',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional Zoho CRM criteria string for filtered counts, such as (Company:equals:ABC).',
          },
          {
            name: 'filter',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional Zoho CRM criteria string for filtered counts. Use criteria when possible.',
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
          {
            name: 'search',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional original user wording for diagnostics only. Do not rely on this instead of structured filters and dates.',
          },
          {
            name: 'retrieval_mode',
            in: 'query',
            required: false,
            type: 'string',
            enum: ['count'],
            description: 'Use count for count requests.',
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
        description: 'Use this operation when the user asks to view, list, show, retrieve, or inspect CRM records. Determine the user\'s requested record count, filters, date range, operation, and fields and pass them as structured inputs. Never default to retrieving the complete module. For "first 10 leads", pass operation=query, limit=10, retrieval_mode=limited. For date or company filters, pass server-side criteria/date inputs and retrieval_mode=filtered with a bounded limit.',
        parameters: [
          {
            name: 'module',
            in: 'query',
            required: true,
            type: 'string',
            description: 'Canonical or natural-language module name. Examples: Leads, Contacts, Accounts, Deals.',
          },
          {
            name: 'operation',
            in: 'query',
            required: false,
            type: 'string',
            enum: ['query', 'count'],
            description: 'Use query for record lists. Use count only when the user asks how many or total records; count returns no records.',
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            type: 'integer',
            format: 'int32',
            minimum: 1,
            maximum: 200,
            description: 'Requested number of records to return. For "first 10" or "10 leads", pass 10. If omitted for a normal list, the backend uses a safe bounded default.',
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
            description: 'Optional Zoho CRM criteria string for server-side filtering. Use criteria when possible.',
          },
          {
            name: 'criteria',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional Zoho CRM criteria string for server-side filtering, such as (Company:equals:ABC).',
          },
          {
            name: 'search',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional original user wording for diagnostics only. Always pass structured limit, criteria, date range, operation, and retrieval_mode when known.',
          },
          {
            name: 'retrieval_mode',
            in: 'query',
            required: false,
            type: 'string',
            enum: ['limited', 'filtered', 'page', 'count'],
            description: 'Use limited for explicit record counts, filtered for date/filter queries, page for explicit pagination, and count for count requests. Do not use all for normal Copilot conversations.',
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
    '/api/crm/activity': {
      get: {
        operationId: 'getCRMActivityReport',
        tags: ['CRM'],
        summary: "Get today's CRM activity and daily audit report",
        description: "Use this operation whenever the user asks for today's CRM activity, what an employee did today, show activity for all employees, or daily changes. Pass user_id for specific user activity or leave empty for all employees. Dates default to today in Asia/Kolkata timezone.",
        parameters: [
          {
            name: 'module',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional CRM module API name to filter activity by (e.g. Deals, Meetings, Notes).',
          },
          {
            name: 'user_id',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional Zoho CRM user ID or user name to filter activity by (e.g. Sanjay).',
          },
          {
            name: 'from',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional start ISO datetime or YYYY-MM-DD string. Defaults to today 00:00:00+05:30.',
          },
          {
            name: 'to',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional end ISO datetime or YYYY-MM-DD string. Defaults to tomorrow 00:00:00+05:30.',
          },
          {
            name: 'action',
            in: 'query',
            required: false,
            type: 'string',
            description: 'Optional action filter such as created, updated, or added.',
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            type: 'integer',
            format: 'int32',
            minimum: 1,
            maximum: 200,
            description: 'Maximum number of activity objects to return. Default is 100.',
          },
        ],
        responses: {
          200: {
            description: 'Successful CRM activity report response',
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                date: { type: 'string' },
                timezone: { type: 'string' },
                count: { type: 'integer', format: 'int32' },
                executionTime: { type: 'string' },
                source: { type: 'string' },
                data: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      user_id: { type: 'string' },
                      user_name: { type: 'string' },
                      module: { type: 'string' },
                      module_api_name: { type: 'string' },
                      record_id: { type: 'string' },
                      record_name: { type: 'string' },
                      action: { type: 'string' },
                      activity_type: { type: 'string' },
                      audited_time: { type: 'string' },
                      source: { type: 'string' },
                    },
                  },
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
    '/api/crm/dashboard': {
      post: {
        operationId: 'generateCRMDashboard',
        tags: ['CRM'],
        summary: 'Generate an enterprise CRM analytics dashboard',
        description: "Use this operation when the user asks for a dashboard (e.g. sales dashboard, management dashboard, activity dashboard, period comparison). Returns structured Dashboard JSON with KPI metrics, stage distributions, employee performance, and trends.",
        parameters: [
          {
            name: 'body',
            in: 'body',
            required: false,
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Dashboard title, e.g. July Sales Dashboard' },
                type: { type: 'string', enum: ['sales', 'management', 'activity', 'comparison'], description: 'Dashboard type' },
                date_from: { type: 'string', description: 'Start date or ISO datetime' },
                date_to: { type: 'string', description: 'End date or ISO datetime' },
                employee: { type: 'string', description: 'Employee name or ID to filter by' },
                theme: {
                  type: 'object',
                  properties: {
                    mode: { type: 'string', enum: ['light', 'dark'] },
                    primaryColor: { type: 'string' },
                    accentColor: { type: 'string' },
                  },
                },
              },
            },
          },
        ],
        responses: {
          200: {
            description: 'Successful CRM dashboard response',
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                dashboard: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    type: { type: 'string' },
                    summary: { type: 'string' },
                    widgets: {
                      type: 'array',
                      items: { type: 'object' },
                    },
                  },
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
      get: {
        operationId: 'getCRMDashboard',
        tags: ['CRM'],
        summary: 'Get enterprise CRM analytics dashboard',
        description: 'Get structured CRM dashboard via query parameters.',
        parameters: [
          { name: 'title', in: 'query', type: 'string', required: false, description: 'Dashboard title' },
          { name: 'type', in: 'query', type: 'string', required: false, enum: ['sales', 'management', 'activity', 'comparison'], description: 'Dashboard type' },
          { name: 'date_from', in: 'query', type: 'string', required: false, description: 'Start date' },
          { name: 'date_to', in: 'query', type: 'string', required: false, description: 'End date' },
          { name: 'employee', in: 'query', type: 'string', required: false, description: 'Employee name or ID' },
        ],
        responses: {
          200: {
            description: 'Successful CRM dashboard response',
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                dashboard: { type: 'object' },
              },
            },
          },
          400: {
            description: 'Validation error',
          },
          401: {
            description: 'Authentication required or invalid OAuth token',
          },
          500: {
            description: 'Server error or Zoho API error',
          },
        },
      },
    },
  },
};

const outPath = path.join(__dirname, 'crm.openapi.json');
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2), 'utf8');
console.log('Wrote', outPath);
