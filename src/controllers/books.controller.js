const { BooksService } = require('../services/books.service');

function createBooksController(booksService = new BooksService()) {
  return {
    query: async (req, res, next) => {
      try {
        const result = await booksService.query(req.body || {});
        res.status(200).json({ success: true, status: 'ok', ...result });
      } catch (error) {
        next(error);
      }
    },
    history: async (req, res, next) => {
      try {
        const result = await booksService.getModuleHistory(req.params.module || req.body?.module, req.query || {});
        res.status(200).json({ success: true, status: 'ok', ...result });
      } catch (error) {
        next(error);
      }
    }
  };
}

module.exports = { createBooksController };
