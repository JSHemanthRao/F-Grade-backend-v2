const express = require('express');
const { createBooksController } = require('../controllers/books.controller');

function createBooksRoutes(booksService) {
  const router = express.Router();
  const controller = createBooksController(booksService);

  router.post('/query', controller.query);
  router.get('/history/:module', controller.history);
  router.post('/history', controller.history);
  return router;
}

module.exports = createBooksRoutes;
