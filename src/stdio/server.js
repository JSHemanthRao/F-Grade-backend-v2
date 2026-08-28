#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { CrmTool } = require('../tools/crmTool');

const server = new Server({
  name: 'f-grade-crm-mcp',
  version: '1.0.0'
}, {
  capabilities: {
    tools: {}
  }
});

const crmTool = new CrmTool();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'query_crm',
    description: 'Send a natural-language CRM question to the backend API and return the backend-generated result.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The natural-language CRM question to send to the backend.',
          minLength: 1,
          maxLength: 2000
        }
      },
      required: ['question'],
      additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      properties: {
        response: {
          type: 'string',
          description: 'The complete answer and requested CRM data returned by the backend.'
        }
      },
      required: ['response'],
      additionalProperties: false
    }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name !== 'query_crm') {
    throw new Error(`Unknown tool: ${name}`);
  }

  try {
    const result = await crmTool.execute(args || {});
    return result;
  } catch (error) {
    const message = error?.code === 'BACKEND_ENDPOINT_NOT_FOUND'
      ? 'Unable to retrieve the requested CRM data because the backend endpoint was not found.'
      : error?.code === 'BACKEND_UNAVAILABLE' || error?.code === 'BACKEND_TIMEOUT'
        ? 'Unable to retrieve the requested CRM data because the backend service is unavailable.'
        : 'Unable to retrieve the requested CRM data because the backend request failed.';
    const response = { response: message };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }],
      structuredContent: response,
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('STDIO server failed to start:', error);
  process.exit(1);
});
