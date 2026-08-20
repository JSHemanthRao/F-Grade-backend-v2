const express = require('express');
const { createCrmController } = require('../controllers/crm.controller');

function createCrmRoutes(crmService) {
	const router = express.Router();
	const controller = createCrmController(crmService);

	router.post('/query', controller.query);
	return router;
}

module.exports = createCrmRoutes;
