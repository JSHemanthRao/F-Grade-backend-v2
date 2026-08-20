const { CrmService } = require('../services/crm.service');

function createCrmController(crmService = new CrmService()) {
  return {
    query: async (req, res, next) => {
      try {
        const result = await crmService.query(req.body);
        res.status(200).json({ success: true, status: 'ok', ...result });
      } catch (error) {
        next(error);
      }
    }
  };
}

module.exports = { createCrmController };
