const CRM_MODULES = {
  Leads: ['id', 'First_Name', 'Last_Name', 'Company', 'Email', 'Phone', 'Lead_Status', 'Lead_Source', 'Owner', 'Created_Time', 'Modified_Time', 'Converted__s', 'Converted_Date_Time'],
  Contacts: ['id', 'First_Name', 'Last_Name', 'Account_Name', 'Email', 'Phone', 'Title', 'Owner', 'Created_Time', 'Modified_Time'],
  Accounts: ['id', 'Account_Name', 'Account_Type', 'Industry', 'Phone', 'Website', 'Billing_City', 'Billing_State', 'Owner', 'Created_Time', 'Modified_Time'],
  Deals: ['id', 'Deal_Name', 'Amount', 'Stage', 'Closing_Date', 'Lead_Conversion_Time', 'Account_Name', 'Type', 'Probability', 'Owner', 'Created_Time', 'Modified_Time'],
  Tasks: ['id', 'Subject', 'Status', 'Due_Date', 'Priority', 'Who_Id', 'What_Id', 'Owner', 'Created_Time', 'Modified_Time'],
  Calls: ['id', 'Subject', 'Call_Type', 'Call_Start_Time', 'Call_Duration', 'Call_Result', 'Status', 'Who_Id', 'What_Id', 'Owner', 'Created_Time', 'Modified_Time'],
  Meetings: ['id', 'Event_Title', 'Venue', 'Start_DateTime', 'End_DateTime', 'Who_Id', 'What_Id', 'Owner', 'Created_Time', 'Modified_Time', 'Participants'],
  Notes: ['id', 'Note_Title', 'Title', 'Note_Content', 'Parent_Id', 'Owner', 'Created_Time', 'Modified_Time'],
  Products: ['id', 'Product_Name', 'Product_Code', 'Unit_Price', 'Qty_in_Stock', 'Description', 'Product_Category', 'Owner', 'Created_Time', 'Modified_Time'],
  Vendors: ['id', 'Vendor_Name', 'Email', 'Phone', 'Website', 'City', 'State', 'Country', 'Category', 'Owner', 'Created_Time', 'Modified_Time'],
  Quotes: ['id', 'Subject', 'Quote_Number', 'Grand_Total', 'Status', 'Valid_Till', 'Account_Name', 'Owner', 'Created_Time', 'Modified_Time'],
  'Sales Orders': ['id', 'Subject', 'SO_Number', 'Sales_Order_Number', 'Grand_Total', 'Status', 'Due_Date', 'Account_Name', 'Owner', 'Created_Time', 'Modified_Time'],
  'Purchase Orders': ['id', 'Subject', 'PO_Number', 'Purchase_Order_Number', 'Grand_Total', 'Status', 'Due_Date', 'Vendor_Name', 'Owner', 'Created_Time', 'Modified_Time'],
  Campaigns: ['id', 'Campaign_Name', 'Campaign_Type', 'Type', 'Status', 'Start_Date', 'End_Date', 'Budgeted_Cost', 'Actual_Cost', 'Owner', 'Created_Time', 'Modified_Time'],
  'Renewal Accounts': ['id', 'Account_Name', 'Renewal_Date', 'Renewal_Status', 'Status', 'Contract_Value', 'Owner', 'Created_Time', 'Modified_Time']
};

const CRM_API_NAMES = Object.freeze({
  Workqueue: 'Workqueue__s',
  Leads: 'Leads',
  Contacts: 'Contacts',
  Accounts: 'Accounts',
  Deals: 'Deals',
  Tasks: 'Tasks',
  Calls: 'Calls',
  Meetings: 'Events',
  Notes: 'Notes',
  Products: 'Products',
  Reports: 'Reports',
  Analytics: 'Analytics',
  SalesInbox: 'SalesInbox',
  Vendors: 'Vendors',
  Quotes: 'Quotes',
  'Sales Orders': 'Sales_Orders',
  'Purchase Orders': 'Purchase_Orders',
  Campaigns: 'Campaigns',
  'Price Books': 'Price_Books',
  Cases: 'Cases',
  Solutions: 'Solutions',
  Documents: 'Documents',
  Forecasts: 'Forecasts',
  Visits: 'Visits',
  Social: 'Social',
  Users: 'users',
  'Remote Assist': 'zohoassist1__Remote_Assist',
  'ZohoSign Documents': 'zohosign__ZohoSign_Documents',
  'ZohoSign Recipients': 'zohosign__ZohoSign_Recipients',
  'ZohoSign Document Events': 'zohosign__ZohoSign_Document_Events',
  'Google Ads': 'Google_AdWords',
  Desk: 'Desk',
  'My Jobs': 'Approvals',
  Messages: 'messages__s',
  'Enterprise leads': 'Enterprise',
  Partners: 'Partners',
  'Renewal Accounts': 'Renewal_Accounts',
  Projects: 'Projects',
  'Service Provider': 'Service_Provider',
  'Co-operative Banks': 'Co_operative_Banks',
  'Zoho Finance': 'Zoho_Books',
  'Voice of the Customer': 'Voice_of_the_Customer__s'
});

for (const moduleName of Object.keys(CRM_API_NAMES)) {
  if (!CRM_MODULES[moduleName]) CRM_MODULES[moduleName] = ['id'];
}

Object.freeze(CRM_MODULES);

module.exports = { CRM_MODULES, CRM_API_NAMES };
