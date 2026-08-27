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
          description: 'The natural-language CRM question to send to the backend.'
        }
      },
      required: ['question'],
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
    const message = error?.message || 'The CRM backend request failed.';
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: {
            code: error?.code || 'TOOL_ERROR',
            message,
            statusCode: error?.statusCode || 500
          }
        }, null, 2)
      }],
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
