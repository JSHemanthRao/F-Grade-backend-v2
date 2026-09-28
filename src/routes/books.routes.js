const express = require('express');
const { BooksService } = require('../services/books.service');

function createBooksRoutes(booksService = new BooksService()) {
  const router = express.Router();
  router.post('/query', async (req, res, next) => {
    try {
      const result = await booksService.query(req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });
  return router;
}

module.exports = createBooksRoutes;
