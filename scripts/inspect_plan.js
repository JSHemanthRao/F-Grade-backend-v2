const { planQuestion } = require('../src/controllers/crm.controller');
const q = "show me today's deals where the stage is not Closed Lost, sorted by amount from highest to lowest";
console.log(JSON.stringify(planQuestion(q), null, 2));
