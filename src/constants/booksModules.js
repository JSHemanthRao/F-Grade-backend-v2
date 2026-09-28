const BOOKS_MODULES = Object.freeze({
  Invoices: ['id', 'Customer_Name', 'Total', 'Status', 'Invoice_Date', 'Due_Date'],
  Estimates: ['id', 'Customer_Name', 'Total', 'Status', 'Estimate_Date'],
  Quotes: ['id', 'Customer_Name', 'Total', 'Status', 'Estimate_Date'],
  Customers: ['id', 'Contact_Name', 'Company_Name', 'Email', 'Phone'],
  Contacts: ['id', 'Contact_Name', 'Company_Name', 'Email', 'Phone'],
  Items: ['id', 'Name', 'Rate', 'Description'],
  Bills: ['id', 'Vendor_Name', 'Total', 'Status', 'Bill_Date', 'Due_Date'],
  Expenses: ['id', 'Account_Name', 'Amount', 'Date'],
  'Price Lists': ['id', 'Name', 'Currency'],
  'Sales Orders': ['id', 'Customer_Name', 'Total', 'Status', 'Date'],
  'Purchase Orders': ['id', 'Vendor_Name', 'Total', 'Status', 'Date']
});

const BOOKS_API_NAMES = Object.freeze({
  Invoices: 'invoices',
  Estimates: 'estimates',
  Quotes: 'estimates',
  Customers: 'contacts',
  Contacts: 'contacts',
  Items: 'items',
  Bills: 'bills',
  Expenses: 'expenses',
  'Price Lists': 'pricelists',
  'Sales Orders': 'salesorders',
  'Purchase Orders': 'purchaseorders',
  'Bank Accounts': 'bankaccounts',
  Projects: 'projects',
  'Payments Received': 'customerpayments',
  'Payments Made': 'vendorpayments'
});

module.exports = { BOOKS_MODULES, BOOKS_API_NAMES };
