const express = require('express');
const { createCrmController } = require('../controllers/crm.controller');

function createCrmRoutes(crmService) {
	const router = express.Router();
	const controller = createCrmController(crmService);

	router.post('/query', controller.query);
	router.post('/test', controller.test);
	router.get('/diagnostics', controller.diagnostics);
	router.post('/assistant', controller.assistant);
	return router;
}

module.exports = createCrmRoutes;
