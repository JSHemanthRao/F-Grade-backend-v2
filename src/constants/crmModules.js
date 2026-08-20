const CRM_MODULES = Object.freeze({
  Leads: ['id', 'First_Name', 'Last_Name', 'Company', 'Email', 'Phone', 'Lead_Status', 'Lead_Source', 'Owner', 'Created_Time', 'Modified_Time'],
  Contacts: ['id', 'First_Name', 'Last_Name', 'Account_Name', 'Email', 'Phone', 'Title', 'Owner', 'Created_Time', 'Modified_Time'],
  Accounts: ['id', 'Account_Name', 'Account_Type', 'Industry', 'Phone', 'Website', 'Billing_City', 'Billing_State', 'Owner', 'Created_Time', 'Modified_Time'],
  Deals: ['id', 'Deal_Name', 'Amount', 'Stage', 'Closing_Date', 'Account_Name', 'Type', 'Probability', 'Owner', 'Created_Time', 'Modified_Time'],
  Tasks: ['id', 'Subject', 'Status', 'Due_Date', 'Priority', 'Who_Id', 'What_Id', 'Owner', 'Created_Time', 'Modified_Time'],
  Calls: ['id', 'Subject', 'Call_Type', 'Call_Start_Time', 'Call_Duration', 'Call_Result', 'Status', 'Who_Id', 'What_Id', 'Owner', 'Created_Time', 'Modified_Time'],
  Meetings: ['id', 'Event_Title', 'Subject', 'Start_DateTime', 'End_DateTime', 'Location', 'Who_Id', 'What_Id', 'Owner', 'Created_Time', 'Modified_Time'],
  Notes: ['id', 'Note_Title', 'Title', 'Note_Content', 'Parent_Id', 'Owner', 'Created_Time', 'Modified_Time'],
  Products: ['id', 'Product_Name', 'Product_Code', 'Unit_Price', 'Qty_in_Stock', 'Description', 'Product_Category', 'Owner', 'Created_Time', 'Modified_Time'],
  Vendors: ['id', 'Vendor_Name', 'Email', 'Phone', 'Website', 'City', 'State', 'Country', 'Category', 'Owner', 'Created_Time', 'Modified_Time'],
  Quotes: ['id', 'Subject', 'Quote_Number', 'Grand_Total', 'Status', 'Valid_Till', 'Account_Name', 'Owner', 'Created_Time', 'Modified_Time'],
  'Sales Orders': ['id', 'Subject', 'SO_Number', 'Sales_Order_Number', 'Grand_Total', 'Status', 'Due_Date', 'Account_Name', 'Owner', 'Created_Time', 'Modified_Time'],
  'Purchase Orders': ['id', 'Subject', 'PO_Number', 'Purchase_Order_Number', 'Grand_Total', 'Status', 'Due_Date', 'Vendor_Name', 'Owner', 'Created_Time', 'Modified_Time'],
  Campaigns: ['id', 'Campaign_Name', 'Campaign_Type', 'Type', 'Status', 'Start_Date', 'End_Date', 'Budgeted_Cost', 'Actual_Cost', 'Owner', 'Created_Time', 'Modified_Time'],
  'Renewal Accounts': ['id', 'Account_Name', 'Renewal_Date', 'Renewal_Status', 'Status', 'Contract_Value', 'Owner', 'Created_Time', 'Modified_Time']
});

const CRM_API_NAMES = Object.freeze({
  Leads: 'Leads',
  Contacts: 'Contacts',
  Accounts: 'Accounts',
  Deals: 'Deals',
  Tasks: 'Tasks',
  Calls: 'Calls',
  Meetings: 'Events',
  Notes: 'Notes',
  Products: 'Products',
  Vendors: 'Vendors',
  Quotes: 'Quotes',
  'Sales Orders': 'Sales_Orders',
  'Purchase Orders': 'Purchase_Orders',
  Campaigns: 'Campaigns',
  'Renewal Accounts': 'Renewal_Accounts'
});

module.exports = { CRM_MODULES, CRM_API_NAMES };
