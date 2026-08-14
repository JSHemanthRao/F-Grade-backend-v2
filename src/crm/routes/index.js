const express = require('express');
const {
  getCRMActivity,
  getDashboardData,
  getModuleCount,
  getModuleQuery,
  handleAssistantRequest,
  renderDashboardView,
} = require('../controllers/crm.controller');
const { handleDnsRequest } = require('../controllers/dns.controller');
const { getSupportedModuleKeys } = require('../services/module-definition.service');
const {
  validateCRMActivityRequest,
  validateCRMCountRequest,
  validateCRMDashboardRequest,
  validateCRMQueryRequest,
} = require('../validators/crm.validator');
const { requestLogger } = require('../middleware/request-logger');
const { crmErrorHandler } = require('../middleware/error-handler');

const router = express.Router();
router.use(requestLogger);

// Activity & Dashboard endpoints
router.get('/activity', validateCRMActivityRequest, getCRMActivity);
router.post('/dashboard', validateCRMDashboardRequest, getDashboardData);
router.get('/dashboard/view', validateCRMDashboardRequest, renderDashboardView);
router.get('/dashboard', validateCRMDashboardRequest, getDashboardData);


const supportedModules = getSupportedModuleKeys();

supportedModules.forEach((moduleName) => {
  router.get(`/${moduleName}`, validateCRMQueryRequest, getModuleQuery);
});

// Dedicated DNS checker endpoint
router.get('/dns', handleDnsRequest);

// New primary read-only dynamic endpoint
router.get('/count', validateCRMCountRequest, getModuleCount);
router.get('/query', validateCRMQueryRequest, getModuleQuery);
router.post('/assistant', handleAssistantRequest);

// Keep root for backward compatibility (resolves module by route path)
router.get('/', validateCRMQueryRequest, getModuleQuery);

// No POST /query - this API is read-only. Error handler remains.
router.use(crmErrorHandler);

module.exports = router;

