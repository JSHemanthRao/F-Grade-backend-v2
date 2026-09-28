const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createCrmController } = require('../src/controllers/crm.controller');

function mockReq(body = {}, path = '/api/crm/audit-log') {
  return {
    body,
    get: () => null,
    crmDiagnostics: null,
    method: 'POST',
    originalUrl: path
  };
}

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

describe('Audit Log Workflow – 7 Exact Verification Tests', () => {
  // 1. Show me all CRM records updated on 25 September 2026.
  it('Test 1: "Show me all CRM records updated on 25 September 2026."', async () => {
    let capturedAuditInput = null;
    const mockCrmService = {
      queryAuditLog: async (input) => {
        capturedAuditInput = input;
        return {
          intent: 'audit_log',
          request_type: 'audit_log',
          count: 1,
          returned: 1,
          records: [
            {
              timestamp: '2026-09-25T14:30:00Z',
              action: 'Updated',
              module: 'Deals',
              record_name: 'Enterprise Contract',
              record_id: 'deal-999',
              performed_by: { id: 'usr-1', name: 'Alice' },
              description: 'Stage changed to Closed Won'
            }
          ],
          pagination: { limit: input.limit || 20, offset: input.offset || 0, returned: 1, more_records: false }
        };
      },
      query: async () => ({ records: [], data: [] }),
      zohoService: {}
    };

    const controller = createCrmController(mockCrmService);
    const req = mockReq({
      request: { question: 'Show me all CRM records updated on 25 September 2026.' }
    });
    const res = mockRes();
    await controller.auditLog(req, res, (err) => { throw err; });

    // Verify tool & operation
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.operation, 'audit_log');

    // Verify inferred date range
    assert.equal(res.body.time_range.start, '2026-09-25');
    assert.equal(res.body.time_range.end, '2026-09-26');

    // Verify inferred action
    assert.ok(res.body.filters.action.includes('updated'));

    // Verify backend passed to Zoho service
    assert.ok(capturedAuditInput);
    assert.equal(capturedAuditInput.audit_log.action, 'Updated');
    assert.equal(capturedAuditInput.audit_log.date_range.start, '2026-09-25');
    assert.equal(capturedAuditInput.audit_log.date_range.end, '2026-09-26');

    // Verify response format
    assert.ok(res.body.table.includes('| Date & Time | Action | Module | Record | Changed By | Details |'));
    assert.ok(res.body.table.includes('Enterprise Contract'));
    assert.equal(res.body.records.length, 1);
    assert.equal(res.body.records[0].record_name, 'Enterprise Contract');
  });

  // 2. Who changed deals yesterday?
  it('Test 2: "Who changed deals yesterday?"', async () => {
    let capturedAuditInput = null;
    const mockCrmService = {
      queryAuditLog: async (input) => {
        capturedAuditInput = input;
        return {
          intent: 'audit_log',
          request_type: 'audit_log',
          count: 1,
          returned: 1,
          records: [
            {
              timestamp: '2026-09-27T09:15:00Z',
              action: 'Updated',
              module: 'Deals',
              record_name: 'SaaS Renewal',
              performed_by: { id: 'usr-2', name: 'Bob' },
              description: 'Amount updated to $50,000'
            }
          ],
          pagination: { limit: input.limit || 20, offset: input.offset || 0, returned: 1, more_records: false }
        };
      },
      query: async () => ({ records: [], data: [] }),
      zohoService: {}
    };

    const controller = createCrmController(mockCrmService);
    const req = mockReq({
      request: { question: 'Who changed deals yesterday?' }
    });
    const res = mockRes();
    await controller.auditLog(req, res, (err) => { throw err; });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.operation, 'audit_log');
    assert.ok(res.body.time_range.start);
    assert.ok(res.body.time_range.end);
    assert.ok(res.body.filters.module.includes('Deals'));
    assert.ok(res.body.filters.action.includes('updated'));

    // Zoho criteria checks
    assert.equal(capturedAuditInput.audit_log.action, 'Updated');
    assert.equal(capturedAuditInput.audit_log.entity, 'Deals');
    assert.ok(res.body.table.includes('SaaS Renewal'));
    assert.ok(res.body.table.includes('Bob'));
  });

  // 3. Show all deleted CRM records from the last seven days.
  it('Test 3: "Show all deleted CRM records from the last seven days."', async () => {
    let capturedAuditInput = null;
    const mockCrmService = {
      queryAuditLog: async (input) => {
        capturedAuditInput = input;
        return {
          intent: 'audit_log',
          request_type: 'audit_log',
          count: 1,
          returned: 1,
          records: [
            {
              timestamp: '2026-09-24T11:00:00Z',
              action: 'Deleted',
              module: 'Contacts',
              record_name: 'Former Lead',
              performed_by: { id: 'usr-3', name: 'Charlie' },
              description: 'Record deleted'
            }
          ],
          pagination: { limit: 20, offset: 0, returned: 1, more_records: false }
        };
      },
      query: async () => ({ records: [], data: [] }),
      zohoService: {}
    };

    const controller = createCrmController(mockCrmService);
    const req = mockReq({
      request: { question: 'Show all deleted CRM records from the last seven days.' }
    });
    const res = mockRes();
    await controller.auditLog(req, res, (err) => { throw err; });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.operation, 'audit_log');
    assert.ok(res.body.filters.action.includes('deleted'));
    assert.equal(capturedAuditInput.audit_log.action, 'Deleted');
    assert.ok(capturedAuditInput.audit_log.date_range.start);
    assert.ok(capturedAuditInput.audit_log.date_range.end);
    assert.ok(res.body.table.includes('Deleted'));
  });

  // 4. Give me all updates made last month.
  it('Test 4: "Give me all updates made last month."', async () => {
    let capturedAuditInput = null;
    const mockCrmService = {
      queryAuditLog: async (input) => {
        capturedAuditInput = input;
        return {
          intent: 'audit_log',
          request_type: 'audit_log',
          count: 0,
          returned: 0,
          records: [],
          pagination: { limit: 20, offset: 0, returned: 0, more_records: false }
        };
      },
      query: async () => ({ records: [], data: [] }),
      zohoService: {}
    };

    const controller = createCrmController(mockCrmService);
    const req = mockReq({
      request: { question: 'Give me all updates made last month.' }
    });
    const res = mockRes();
    await controller.auditLog(req, res, (err) => { throw err; });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.operation, 'audit_log');
    assert.ok(res.body.filters.action.includes('updated'));
    assert.equal(capturedAuditInput.audit_log.action, 'Updated');
    assert.ok(capturedAuditInput.audit_log.date_range.start);
    assert.ok(capturedAuditInput.audit_log.date_range.end);
    // When 0 records found:
    assert.equal(res.body.table, 'No matching records were returned.');
  });

  // 5. Show changes made by Kumar yesterday.
  it('Test 5: "Show changes made by Kumar yesterday."', async () => {
    let capturedAuditInput = null;
    const mockCrmService = {
      queryAuditLog: async (input) => {
        capturedAuditInput = input;
        return {
          intent: 'audit_log',
          request_type: 'audit_log',
          count: 1,
          returned: 1,
          records: [
            {
              timestamp: '2026-09-27T16:00:00Z',
              action: 'Updated',
              module: 'Leads',
              record_name: 'TechCorp Lead',
              performed_by: { id: 'usr-k', name: 'Kumar' },
              description: 'Phone number updated'
            }
          ],
          pagination: { limit: 20, offset: 0, returned: 1, more_records: false }
        };
      },
      query: async () => ({ records: [], data: [] }),
      zohoService: {}
    };

    const controller = createCrmController(mockCrmService);
    const req = mockReq({
      request: { question: 'Show changes made by Kumar yesterday.' }
    });
    const res = mockRes();
    await controller.auditLog(req, res, (err) => { throw err; });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.operation, 'audit_log');
    assert.ok(res.body.filters.action.includes('updated'));
    assert.ok(res.body.filters.done_by.includes('Kumar'));
    assert.equal(capturedAuditInput.audit_log.user.name, 'Kumar');
    assert.ok(res.body.table.includes('Kumar'));
  });

  // 6. Give me the audit history for yesterday.
  it('Test 6: "Give me the audit history for yesterday."', async () => {
    let capturedAuditInput = null;
    const mockCrmService = {
      queryAuditLog: async (input) => {
        capturedAuditInput = input;
        return {
          intent: 'audit_log',
          request_type: 'audit_log',
          count: 2,
          returned: 2,
          records: [
            {
              timestamp: '2026-09-27T08:00:00Z',
              action: 'Added',
              module: 'Contacts',
              record_name: 'David Lee',
              performed_by: { id: 'usr-1', name: 'Admin' },
              description: 'Contact created'
            },
            {
              timestamp: '2026-09-27T12:00:00Z',
              action: 'Deleted',
              module: 'Accounts',
              record_name: 'Old Account',
              performed_by: { id: 'usr-1', name: 'Admin' },
              description: 'Account removed'
            }
          ],
          pagination: { limit: 20, offset: 0, returned: 2, more_records: false }
        };
      },
      query: async () => ({ records: [], data: [] }),
      zohoService: {}
    };

    const controller = createCrmController(mockCrmService);
    const req = mockReq({
      request: { question: 'Give me the audit history for yesterday.' }
    });
    const res = mockRes();
    await controller.auditLog(req, res, (err) => { throw err; });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.operation, 'audit_log');
    assert.ok(capturedAuditInput.audit_log.date_range.start);
    assert.ok(capturedAuditInput.audit_log.date_range.end);
    assert.equal(res.body.records.length, 2);
    assert.ok(res.body.table.includes('David Lee'));
    assert.ok(res.body.table.includes('Old Account'));
  });

  // 7. Show calls made yesterday. -> Must use normal CRM Calls module, NOT Audit Log!
  it('Test 7: "Show calls made yesterday." must route to normal CRM Calls module', async () => {
    let capturedCrmPlan = null;
    const mockCrmService = {
      queryAuditLog: async () => {
        throw new Error('Should not call queryAuditLog for normal CRM calls query!');
      },
      query: async (plan) => {
        capturedCrmPlan = plan;
        return {
          module: 'Calls',
          request_type: 'records',
          count: 1,
          returned: 1,
          records: [
            {
              id: 'call-1',
              Subject: 'Client Follow-up',
              Call_Start_Time: '2026-09-27T10:00:00Z',
              Call_Type: 'Outbound'
            }
          ],
          data: [
            {
              id: 'call-1',
              Subject: 'Client Follow-up',
              Call_Start_Time: '2026-09-27T10:00:00Z',
              Call_Type: 'Outbound'
            }
          ],
          pagination: { limit: 20, offset: 0, returned: 1, more_records: false }
        };
      },
      zohoService: {
        resolveModuleApiName: async (mod) => mod,
        getFieldMetadata: async () => ({ fields: ['id', 'Subject', 'Call_Start_Time', 'Call_Type'], metadata: [] })
      }
    };

    const controller = createCrmController(mockCrmService);
    const req = mockReq({ question: 'Show calls made yesterday.' }, '/api/crm/assistant');
    const res = mockRes();
    await controller.assistant(req, res, (err) => { throw err; });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    // Verifies module is Calls (NOT Audit Log)
    assert.equal(res.body.module, 'Calls');
    assert.equal(res.body.request_type, 'records');
    assert.ok(capturedCrmPlan);
    assert.equal(capturedCrmPlan.module, 'Calls');
  });
});
