const express = require('express');
const { createCrmController } = require('../controllers/crm.controller');

function createCrmRoutes(crmService) {
	const router = express.Router();
	const controller = createCrmController(crmService);

	router.post('/query', controller.query);
	router.get('/diagnostics', controller.diagnostics);
	router.post('/assistant', controller.assistant);
	router.post('/assistant/fast-summary', controller.fastSummary);
	router.get('/metadata', controller.metadata);
	router.post('/metadata/refresh', controller.refreshMetadata);
	return router;
}

module.exports = createCrmRoutes;
