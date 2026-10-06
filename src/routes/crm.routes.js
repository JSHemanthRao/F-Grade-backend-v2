const express = require('express');
const { createCrmController } = require('../controllers/crm.controller');
const { rejectUnsafeBotInput, requestTimeout, selectCrmRateLimiter } = require('../middleware/botProtection');

const passThrough = (_req, _res, next) => next();

function createCrmRoutes(crmService, {
	apiKeyAuth = (_req, _res, next) => next(),
	rateLimiters = {},
	requestTimeoutMs
} = {}) {
	const router = express.Router();
	const controller = createCrmController(crmService);

	router.post('/assistant',
		rejectUnsafeBotInput({
			allowedKeys: ['question', 'prompt', 'message', 'original_question', 'request', 'schema_version', 'pagination', 'limit', 'offset'],
			nestedKeys: { request: ['question', 'pagination'], pagination: ['limit', 'offset'] }
		}),
		selectCrmRateLimiter(rateLimiters),
		requestTimeout(requestTimeoutMs),
		controller.assistant
	);
	router.post('/audit-log',
		rejectUnsafeBotInput({
			allowedKeys: ['request', 'question', 'operation', 'time_range', 'filters', 'pagination'],
			nestedKeys: {
				request: ['question', 'operation', 'time_range', 'filters', 'pagination'],
				time_range: ['start', 'end'],
				filters: ['action', 'module', 'done_by'],
				pagination: ['limit', 'offset']
			}
		}),
		rateLimiters.audit || passThrough,
		requestTimeout(requestTimeoutMs),
		controller.auditLog
	);

	router.use(apiKeyAuth);
	router.post('/query', controller.query);
	router.get('/diagnostics', controller.diagnostics);
	router.post('/audit-log/assistant', controller.assistant);
	router.post('/assistant/fast-summary', controller.fastSummary);
	router.get('/metadata', controller.metadata);
	router.post('/metadata/refresh', controller.refreshMetadata);
	return router;
}

module.exports = createCrmRoutes;
