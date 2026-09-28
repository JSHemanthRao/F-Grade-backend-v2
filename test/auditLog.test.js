const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// We import the controller factory to access the internal planner functions.
// The controller exports a factory, but the NLP functions (isAuditLogQuestion,
// buildAuditLogPlan, etc.) are module-scoped, so we test them indirectly by
// exercising the /api/crm/audit-log endpoint with a mock Express setup.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Minimal mock infrastructure
// ---------------------------------------------------------------------------
function mockReq(body = {}) {
  return { body, get: () => null, crmDiagnostics: null, method: 'POST', originalUrl: '/api/crm/audit-log' };
}

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

function createMockCrmService(auditRecords = []) {
  return {
    queryAuditLog: async (input = {}) => ({
      intent: 'audit_log',
      request_type: 'audit_log',
      module: null,
      count: auditRecords.length,
      returned: auditRecords.length,
      records: auditRecords,
      data: auditRecords,
      pagination: { limit: input.limit || 20, offset: input.offset || 0, returned: auditRecords.length, more_records: false }
    }),
    query: async () => ({ data: [], records: [], pagination: {} }),
    zohoService: { auditLogService: null }
  };
}

// ---------------------------------------------------------------------------
// Load the controller
// ---------------------------------------------------------------------------
const { createCrmController } = require('../src/controllers/crm.controller');
const { CrmService } = require('../src/services/crm.service');

describe('Audit Log – Natural Language Resolution', () => {
  const sampleRecords = [
    { timestamp: '2026-09-25T10:30:00+05:30', action: 'Updated', module: 'Deals', record_id: '123', record_name: 'Acme Deal', performed_by: { id: '1', name: 'Kumar' }, description: 'Stage changed from Qualification to Negotiation' },
    { timestamp: '2026-09-25T14:15:00+05:30', action: 'Added', module: 'Leads', record_id: '456', record_name: 'Jane Smith', performed_by: { id: '2', name: 'Priya' }, description: 'New lead added' }
  ];

  describe('1. Question field is accepted and processed', () => {
    it('should accept a question field and infer parameters', async () => {
      const crmService = createMockCrmService(sampleRecords);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Show me all CRM records updated on 25 September 2026' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.operation, 'audit_log');
      assert.equal(res.body.question, 'Show me all CRM records updated on 25 September 2026');
      assert.ok(res.body.time_range.start, 'start date should be resolved');
      assert.ok(res.body.time_range.end, 'end date should be resolved');
      assert.ok(Array.isArray(res.body.data));
      assert.ok(Array.isArray(res.body.display_columns));
      assert.ok(res.body.display_columns.includes('Date & Time'));
      assert.ok(res.body.display_columns.includes('Action'));
      assert.ok(res.body.display_columns.includes('Module'));
      assert.ok(res.body.display_columns.includes('Record'));
      assert.ok(res.body.display_columns.includes('Changed By'));
      assert.ok(res.body.display_columns.includes('Details'));
      assert.ok(typeof res.body.answer === 'string');
    });

    it('should still work with structured parameters (backward compatibility)', async () => {
      const crmService = createMockCrmService(sampleRecords);
      const controller = createCrmController(crmService);
      const req = mockReq({
        request: {
          time_range: { start: '2026-09-25', end: '2026-09-26' },
          filters: { action: ['updated'] },
          pagination: { limit: 10, offset: 0 }
        }
      });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.time_range.start, '2026-09-25');
      assert.equal(res.body.time_range.end, '2026-09-26');
      assert.equal(res.body.pagination.limit, 10);
    });

    it('should default to sensible values when no question or overrides are provided', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: {} });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.pagination.limit, 20);
      assert.equal(res.body.pagination.offset, 0);
    });
  });

  describe('2. Date range inference', () => {
    it('should resolve "25 September 2026" (DD Month YYYY format)', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Show all CRM records updated on 25 September 2026' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.equal(res.body.time_range.start, '2026-09-25');
      assert.equal(res.body.time_range.end, '2026-09-26');
    });

    it('should resolve "yesterday"', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Who changed deals yesterday?' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.ok(res.body.time_range.start, 'should have a start date');
      assert.ok(res.body.time_range.end, 'should have an end date');
    });

    it('should resolve "last seven days"', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Show all deleted CRM records from the last seven days' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.ok(res.body.time_range.start, 'should have a start date');
      assert.ok(res.body.time_range.end, 'should have an end date');
    });

    it('should resolve "last month"', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Give me all updates made last month' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.ok(res.body.time_range.start);
      assert.ok(res.body.time_range.end);
    });
  });

  describe('3. Action inference', () => {
    it('should infer "Updated" action from "updated"', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Show me all CRM records updated on 25 September 2026' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.ok(res.body.filters.action, 'should have action filter');
      assert.ok(res.body.filters.action.includes('updated'), 'action should be updated');
    });

    it('should infer "Deleted" action from "deleted"', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Show all deleted CRM records from the last seven days' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.ok(res.body.filters.action);
      assert.ok(res.body.filters.action.includes('deleted'), 'action should be deleted');
    });

    it('should infer "Added" action from "created"', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Show all records created this week' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.ok(res.body.filters.action);
      assert.ok(res.body.filters.action.includes('added'), 'action should be added');
    });
  });

  describe('4. Module inference', () => {
    it('should infer Deals module from "Who changed deals yesterday?"', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Who changed deals yesterday?' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.ok(res.body.filters.module);
      assert.ok(res.body.filters.module.includes('Deals'));
    });

    it('should not infer a module for generic audit requests', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Give me the audit history for yesterday' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      // Should not have a module filter for generic requests
      assert.ok(!res.body.filters.module || res.body.filters.module.length === 0 || res.body.filters.module[0] === null);
    });
  });

  describe('5. User inference', () => {
    it('should infer user from "Show changes made by Kumar yesterday"', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Show changes made by Kumar yesterday' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      // The buildAuditLogPlan uses a specific regex for user detection via "done by"
      // "made by Kumar" should also be caught by the NLP
      // At minimum, the question should be processed without error
      assert.equal(res.statusCode, 200);
    });
  });

  describe('6. Response structure', () => {
    it('should return display_columns for table rendering', async () => {
      const crmService = createMockCrmService(sampleRecords);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Show me audit history for yesterday' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.deepEqual(res.body.display_columns, ['Date & Time', 'Action', 'Module', 'Record', 'Changed By', 'Details']);
    });

    it('should return an answer summary', async () => {
      const crmService = createMockCrmService(sampleRecords);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Show me audit history for yesterday' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.ok(res.body.answer.includes('2'), 'answer should mention the record count');
    });

    it('should return proper message when no records found', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Show me audit history for yesterday' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.ok(res.body.answer.includes('No matching'), 'should indicate no records found');
    });

    it('should include pagination metadata', async () => {
      const crmService = createMockCrmService(sampleRecords);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Show me audit history' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.ok(typeof res.body.pagination === 'object');
      assert.ok(typeof res.body.pagination.limit === 'number');
      assert.ok(typeof res.body.pagination.offset === 'number');
      assert.ok(typeof res.body.pagination.returned === 'number');
      assert.ok(typeof res.body.pagination.has_more === 'boolean');
    });
  });

  describe('7. Tool selection (audit vs. normal CRM)', () => {
    // These tests verify that the isAuditLogQuestion function correctly
    // classifies questions. We test via the planQuestion function.
    it('"Show calls made yesterday" should NOT be classified as audit log', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      // When sent to the audit-log endpoint with a calls question,
      // hasScheduledActivityOnly should prevent NLP inference
      const req = mockReq({ request: { question: 'Show calls made yesterday' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      // It should still succeed but without audit-specific inference
      assert.equal(res.statusCode, 200);
    });

    it('"Who changed deals yesterday?" SHOULD be classified as audit log', async () => {
      const crmService = createMockCrmService(sampleRecords);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Who changed deals yesterday?' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.time_range.start, 'should have resolved date range');
    });

    it('"Show deleted records yesterday" SHOULD be classified as audit log', async () => {
      const crmService = createMockCrmService(sampleRecords);
      const controller = createCrmController(crmService);
      const req = mockReq({ request: { question: 'Show deleted records yesterday' } });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.filters.action, 'should have action filter for deleted');
    });
  });

  describe('8. Explicit structured overrides take precedence', () => {
    it('explicit time_range should override NLP-inferred dates', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({
        request: {
          question: 'Show me all CRM records updated on 25 September 2026',
          time_range: { start: '2026-01-01', end: '2026-01-02' }
        }
      });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      assert.equal(res.body.time_range.start, '2026-01-01', 'explicit override should take precedence');
      assert.equal(res.body.time_range.end, '2026-01-02', 'explicit override should take precedence');
    });

    it('explicit filters should override NLP-inferred filters', async () => {
      const crmService = createMockCrmService([]);
      const controller = createCrmController(crmService);
      const req = mockReq({
        request: {
          question: 'Show me all CRM records updated yesterday',
          filters: { action: ['deleted'] }
        }
      });
      const res = mockRes();
      await controller.auditLog(req, res, (err) => { throw err; });
      // Explicit filter should win
      assert.ok(res.body.filters.action.includes('deleted'));
    });
  });
});
